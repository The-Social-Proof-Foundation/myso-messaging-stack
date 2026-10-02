import { describe, expect, it } from 'vitest';
import { bcs } from '@socialproof/myso/bcs';
import type { Transaction } from '@socialproof/myso/transactions';
import { normalizeMySoAddress, toBase64 } from '@socialproof/myso/utils';

import { blockWalletTx } from './block-wallet';

const REGISTRY = '0x' + '11'.repeat(32);
const GRAPH = '0x' + '22'.repeat(32);
const PEER = '0x' + 'ab'.repeat(32);
const PACKAGE = '0x' + '50c1'.padStart(64, '0');

const obj = (id: string) => `obj:${normalizeMySoAddress(id)}`;
const pure = (bytes: Uint8Array) => `pure:${toBase64(bytes)}`;
const addr = (value: string) => pure(bcs.Address.serialize(value).toBytes());

type Input =
  | { $kind: 'UnresolvedObject'; UnresolvedObject: { objectId: string } }
  | { $kind: 'Pure'; Pure: { bytes: string } };
type Arg =
  | { $kind: 'Input'; Input: number }
  | { $kind: 'NestedResult'; NestedResult: [number, number] };

function lastMoveCall(tx: Transaction): { target: string; args: string[] } {
  const data = tx.getData() as unknown as {
    inputs: Input[];
    commands: {
      $kind: string;
      MoveCall?: { module: string; function: string; arguments: Arg[] };
    }[];
  };
  const call = [...data.commands].reverse().find((c) => c.$kind === 'MoveCall')
    ?.MoveCall;
  if (!call) throw new Error('no MoveCall');
  const args = call.arguments.map((arg) => {
    if (arg.$kind === 'NestedResult') return `result:${arg.NestedResult[0]}`;
    const input = data.inputs[arg.Input]!;
    return input.$kind === 'Pure'
      ? `pure:${input.Pure.bytes}`
      : `obj:${input.UnresolvedObject.objectId}`;
  });
  return { target: `${call.module}::${call.function}`, args };
}

describe('blockWalletTx', () => {
  it('calls block_wallet(registry, social graph, peer)', () => {
    const tx = blockWalletTx(
      {
        socialPackageId: PACKAGE,
        blockListRegistryId: REGISTRY,
        socialGraphId: GRAPH,
      },
      PEER,
    );
    expect(lastMoveCall(tx)).toEqual({
      target: 'block_list::block_wallet',
      args: [obj(REGISTRY), obj(GRAPH), addr(PEER)],
    });
  });

  it('refuses to build without registry ids', () => {
    expect(() =>
      blockWalletTx(
        { blockListRegistryId: '', socialGraphId: GRAPH },
        PEER,
      ),
    ).toThrow(/not configured/);
  });
});
