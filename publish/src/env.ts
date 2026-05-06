import { z } from "zod";

const envSchema = z.object({
  MYSO_NETWORK: z.enum(["mainnet", "testnet", "devnet", "localnet"]),
  MYSO_FULLNODE_URL: z.url(),
  ADMIN_ADDRESS: z.string().optional(),
  ADMIN_SECRET_KEY: z.string().optional(),
  MOVE_PACKAGE_PATH: z.string().optional(),
});

export const ENV = envSchema.parse({
  MYSO_NETWORK: process.env.MYSO_NETWORK,
  MYSO_FULLNODE_URL: process.env.MYSO_FULLNODE_URL,
  ADMIN_ADDRESS: process.env.ADMIN_ADDRESS,
  ADMIN_SECRET_KEY: process.env.ADMIN_SECRET_KEY,
  MOVE_PACKAGE_PATH: process.env.MOVE_PACKAGE_PATH,
});
