import { BaseClient } from "@socialproof/myso/client";
import { Transaction } from "@socialproof/myso/transactions";
import { resolve } from "node:path";

/**
 * Builds and returns the unsigned bytes for the transaction of publishing the Move package located at `packagePath`.
 *
 * @param packagePath - The relative file system path to the Move package to be published.
 * @param mysoClient - An instance of BaseClient to interact with the MySo network.
 * @param sender - The MySo address of the sender who will publish the package.
 * @param exec - A function to execute shell commands, used to run `myso move build`. Provides flexibility for testing in custom execution environments (eg TestContainers).
 * @returns A Promise that resolves to a base64-encoded string representing the unsigned transaction bytes.
 */
export const getPublishBytes = async ({
  packagePath,
  mysoClient,
  sender,
  exec,
}: {
  packagePath: string;
  mysoClient: BaseClient;
  sender: string;
  exec: (command: string) => Promise<string>;
}): Promise<string> => {
  // Build the move package and keep the meaningful part of the output
  const absolutePath = resolve(process.cwd(), packagePath);
  const output = await exec(
    `myso move build --dump-bytecode-as-base64 --path ${absolutePath}`,
  );
  const bodyStart = output.indexOf('{"modules"');
  if (bodyStart === -1) {
    throw new Error(`Invalid output:\n${output}`);
  }
  const body = output.slice(bodyStart);
  const { modules, dependencies } = JSON.parse(body);
  // Build the publish transaction and return the unsigned bytes
  const tx = new Transaction();
  const upgradeCap = tx.publish({
    modules,
    dependencies,
  });
  tx.transferObjects([upgradeCap], sender);
  tx.setSender(sender);
  const bytes = await tx.build({
    client: mysoClient,
  });
  return Buffer.from(bytes).toString("base64");
};
