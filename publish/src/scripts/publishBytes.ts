import { MySoJsonRpcClient } from "@socialproof/myso/jsonRpc";
import { ENV } from "../env.js";
import { getPublishBytes } from "../utils/getPublishBytes.js";
import { execSync } from "node:child_process";
import * as fs from "fs";
import path from "node:path";

/**
 * Prints and returns the unsigned publish bytes for the Move package specified in the .env file.
 * This can be used in a GH action to share the publish bytes for signing, when needing a multi-sig or KMS account.
 */
export const publishBytes = async () => {
  if (!ENV.MOVE_PACKAGE_PATH) {
    throw new Error("MOVE_PACKAGE_PATH is not defined in the .env");
  }
  if (!ENV.ADMIN_ADDRESS) {
    throw new Error("ADMIN_ADDRESS is not defined in the .env");
  }

  const mysoClient = new MySoJsonRpcClient({
    url: ENV.MYSO_FULLNODE_URL,
    network: ENV.MYSO_NETWORK,
  });

  const unsignedBytes = await getPublishBytes({
    packagePath: ENV.MOVE_PACKAGE_PATH,
    mysoClient,
    sender: ENV.ADMIN_ADDRESS,
    exec: execSync as any,
  });
  console.log("Unsigned Publish Bytes (base64):");
  console.log(unsignedBytes);

  if (!fs.existsSync("data")) {
    fs.mkdirSync("data");
  }
  fs.writeFileSync(["data", "publish-bytes.txt"].join(path.sep), unsignedBytes);
  console.log("Response details stored in data/publish-bytes.txt");

  return unsignedBytes;
};

publishBytes();
