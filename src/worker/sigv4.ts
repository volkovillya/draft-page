/**
 * Signs requests to the app's internal API with the Lambda's own IAM role (SigV4 for
 * "execute-api"). API Gateway checks the signature before anything reaches the app, so there
 * is no shared secret or API key to store (decision D11).
 */
import { Sha256 } from "@aws-crypto/sha256-js";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import type { SignedRequest } from "./internal-api";

/** The Lambda runtime puts the role's temporary credentials in these variables. */
function credentialsFromEnv() {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) throw new Error("No AWS credentials in the environment");
  return { accessKeyId, secretAccessKey, sessionToken: process.env.AWS_SESSION_TOKEN };
}

export function sigV4Headers(region: string) {
  const signer = new SignatureV4({ credentials: async () => credentialsFromEnv(), region, service: "execute-api", sha256: Sha256 });
  return async (request: SignedRequest): Promise<Record<string, string>> => {
    const signed = await signer.sign(
      new HttpRequest({
        method: request.method,
        protocol: request.url.protocol,
        hostname: request.url.hostname,
        path: request.url.pathname,
        headers: request.headers,
        body: request.body,
      }),
    );
    return signed.headers as Record<string, string>;
  };
}
