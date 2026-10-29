import type { RequestHandler } from "express";
import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";

export type Principal =
  | { type: "user"; provider: "entra"; subject: string; name?: string }
  | {
      type: "service";
      provider: "kubernetes";
      serviceAccount: string;
      namespace: string;
    };

declare global {
  namespace Express {
    interface Request {
      principal?: Principal;
    }
  }
}

export const workloadAudience = "urn:identity-poc:api";
const allowedService = "system:serviceaccount:identity-poc:reporting-worker";

export interface ReviewResult {
  authenticated?: boolean;
  audiences?: string[];
  user?: { username?: string };
}

export interface AuthConfig {
  issuer: string;
  audience: string;
  jwks: ReturnType<typeof createRemoteJWKSet>;
  review: (token: string) => Promise<ReviewResult | undefined>;
}

export function createAuthenticate(config: AuthConfig): RequestHandler {
  return async function authenticate(req, res, next) {
    const [scheme, token, extra] = (req.headers.authorization ?? "").split(" ");
    if (!/^Bearer$/i.test(scheme) || !token || extra !== undefined) {
      res.status(401).json({ error: "Authorization required" });
      return;
    }

    try {
      // The untrusted issuer selects a validator; it never authenticates a caller.
      if (decodeJwt(token).iss === config.issuer) {
        const { payload } = await jwtVerify(token, config.jwks, {
          issuer: config.issuer,
          audience: config.audience,
          algorithms: ["RS256"],
          requiredClaims: ["sub", "exp", "iat"],
        });
        if (
          !payload.sub ||
          typeof payload.scp !== "string" ||
          !payload.scp.split(" ").includes("access_as_user")
        ) {
          throw new Error("Delegated access token required");
        }
        req.principal = {
          type: "user",
          provider: "entra",
          subject: payload.sub,
          ...(typeof payload.name === "string" ? { name: payload.name } : {}),
        };
      } else {
        const review = await config.review(token);
        if (
          review?.authenticated !== true ||
          !review.audiences?.includes(workloadAudience)
        ) {
          throw new Error("Invalid workload token");
        }
        if (review.user?.username !== allowedService) {
          res.status(403).json({ error: "ServiceAccount not authorized" });
          return;
        }
        req.principal = {
          type: "service",
          provider: "kubernetes",
          serviceAccount: "reporting-worker",
          namespace: "identity-poc",
        };
      }
      next();
    } catch {
      res.status(401).json({ error: "Invalid token" });
    }
  };
}
