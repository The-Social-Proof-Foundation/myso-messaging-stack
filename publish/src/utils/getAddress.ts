import { getSigner } from "./getSigner.js";

/**
 * Returns the MySo address associated with the provided base64-encoded secret key.
 *
 * @param secretKey - A base64-encoded string representing the secret key.
 * @returns The MySo address as a string.
 */
export const getAddress = (secretKey: string) => {
  const signer = getSigner(secretKey);
  return signer.toMySoAddress();
};
