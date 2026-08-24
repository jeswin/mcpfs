import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type RegisteredClient = {
  clientId: string;
  clientSecretHash: string;
  redirectUris: string[];
  clientName?: string | undefined;
  createdAt: number;
};

export type RefreshTokenRecord = {
  clientId: string;
  expiresAt: number;
};

type AccessTokenRecord = {
  expiresAt: number;
};

type PersistedClient = RegisteredClient;

type PersistedOAuthState = {
  version: 1;
  accessTokens: Array<{ tokenHash: string; expiresAt: number }>;
  refreshTokens: Array<{ tokenHash: string; clientId: string; expiresAt: number }>;
  registeredClients: PersistedClient[];
};

const HASH_PATTERN = /^[a-f0-9]{64}$/;

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid OAuth state: ${field} must be a non-empty string`);
  }
  return value;
}

function parseState(value: unknown): PersistedOAuthState {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("Invalid OAuth state: unsupported or missing version");
  }

  if (!Array.isArray(value.accessTokens)) {
    throw new Error("Invalid OAuth state: accessTokens must be an array");
  }
  if (!Array.isArray(value.refreshTokens)) {
    throw new Error("Invalid OAuth state: refreshTokens must be an array");
  }
  if (!Array.isArray(value.registeredClients)) {
    throw new Error("Invalid OAuth state: registeredClients must be an array");
  }

  const accessTokens = value.accessTokens.map((entry, index) => {
    if (
      !isRecord(entry) ||
      typeof entry.tokenHash !== "string" ||
      !isFiniteTimestamp(entry.expiresAt)
    ) {
      throw new Error(`Invalid OAuth state: accessTokens[${index}]`);
    }
    if (!HASH_PATTERN.test(entry.tokenHash)) {
      throw new Error(`Invalid OAuth state: accessTokens[${index}].tokenHash`);
    }
    return { tokenHash: entry.tokenHash, expiresAt: entry.expiresAt };
  });

  const refreshTokens = value.refreshTokens.map((entry, index) => {
    if (
      !isRecord(entry) ||
      typeof entry.tokenHash !== "string" ||
      !isFiniteTimestamp(entry.expiresAt)
    ) {
      throw new Error(`Invalid OAuth state: refreshTokens[${index}]`);
    }
    if (!HASH_PATTERN.test(entry.tokenHash)) {
      throw new Error(`Invalid OAuth state: refreshTokens[${index}].tokenHash`);
    }
    return {
      tokenHash: entry.tokenHash,
      clientId: requireString(entry.clientId, `refreshTokens[${index}].clientId`),
      expiresAt: entry.expiresAt,
    };
  });

  const registeredClients = value.registeredClients.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`Invalid OAuth state: registeredClients[${index}]`);
    }
    const clientSecretHash = requireString(
      entry.clientSecretHash,
      `registeredClients[${index}].clientSecretHash`
    );
    if (!HASH_PATTERN.test(clientSecretHash)) {
      throw new Error(`Invalid OAuth state: registeredClients[${index}].clientSecretHash`);
    }
    if (
      !Array.isArray(entry.redirectUris) ||
      entry.redirectUris.some((uri) => typeof uri !== "string")
    ) {
      throw new Error(`Invalid OAuth state: registeredClients[${index}].redirectUris`);
    }
    if (!isFiniteTimestamp(entry.createdAt)) {
      throw new Error(`Invalid OAuth state: registeredClients[${index}].createdAt`);
    }

    const clientName = entry.clientName;
    if (clientName !== undefined && typeof clientName !== "string") {
      throw new Error(`Invalid OAuth state: registeredClients[${index}].clientName`);
    }

    return {
      clientId: requireString(entry.clientId, `registeredClients[${index}].clientId`),
      clientSecretHash,
      redirectUris: [...entry.redirectUris],
      ...(clientName === undefined ? {} : { clientName }),
      createdAt: entry.createdAt,
    };
  });

  return { version: 1, accessTokens, refreshTokens, registeredClients };
}

function hashesMatch(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

/**
 * Small single-process OAuth state store.
 *
 * Only one-way hashes of bearer/client secrets are persisted. Writes are
 * serialized and use a same-directory temporary file followed by rename so a
 * crash cannot leave a partially written JSON document behind.
 */
export type OAuthStateStore = ReturnType<typeof createOAuthStateStore>;

export function createOAuthStateStore(filePath: string) {
  const accessTokens = new Map<string, AccessTokenRecord>();
  const refreshTokens = new Map<string, RefreshTokenRecord>();
  const registeredClients = new Map<string, RegisteredClient>();
  let writeQueue: Promise<void> = Promise.resolve();

  async function load(): Promise<void> {
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") {
        return;
      }
      throw error;
    }

    const state = parseState(JSON.parse(content) as unknown);
    const now = Date.now();

    accessTokens.clear();
    refreshTokens.clear();
    registeredClients.clear();

    for (const token of state.accessTokens) {
      if (token.expiresAt > now) {
        accessTokens.set(token.tokenHash, { expiresAt: token.expiresAt });
      }
    }
    for (const token of state.refreshTokens) {
      if (token.expiresAt > now) {
        refreshTokens.set(token.tokenHash, {
          clientId: token.clientId,
          expiresAt: token.expiresAt,
        });
      }
    }
    for (const client of state.registeredClients) {
      registeredClients.set(client.clientId, {
        ...client,
        redirectUris: [...client.redirectUris],
      });
    }

    if (
      state.accessTokens.length !== accessTokens.size ||
      state.refreshTokens.length !== refreshTokens.size
    ) {
      await persist();
    }
  }

  function getClient(clientId: string): RegisteredClient | undefined {
    const client = registeredClients.get(clientId);
    return client ? { ...client, redirectUris: [...client.redirectUris] } : undefined;
  }

  async function registerClient(client: RegisteredClient): Promise<void> {
    const previousClient = registeredClients.get(client.clientId);
    registeredClients.set(client.clientId, {
      ...client,
      redirectUris: [...client.redirectUris],
    });
    try {
      await persist();
    } catch (error) {
      if (previousClient) {
        registeredClients.set(client.clientId, previousClient);
      } else {
        registeredClients.delete(client.clientId);
      }
      throw error;
    }
  }

  function verifyClientSecret(clientId: string, clientSecret: string): boolean {
    const client = registeredClients.get(clientId);
    return client ? hashesMatch(client.clientSecretHash, hashSecret(clientSecret)) : false;
  }

  function validateAccessToken(token: string): boolean {
    const tokenHash = hashSecret(token);
    const tokenData = accessTokens.get(tokenHash);
    if (!tokenData) return false;
    if (Date.now() > tokenData.expiresAt) {
      accessTokens.delete(tokenHash);
      void persist().catch(() => undefined);
      return false;
    }
    return true;
  }

  function getRefreshToken(token: string): RefreshTokenRecord | undefined {
    return refreshTokens.get(hashSecret(token));
  }

  async function deleteRefreshToken(token: string): Promise<void> {
    const tokenHash = hashSecret(token);
    const previousToken = refreshTokens.get(tokenHash);
    if (!previousToken) return;

    refreshTokens.delete(tokenHash);
    try {
      await persist();
    } catch (error) {
      refreshTokens.set(tokenHash, previousToken);
      throw error;
    }
  }

  async function issueAccessToken(expiresAt: number): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    const tokenHash = hashSecret(token);
    accessTokens.set(tokenHash, { expiresAt });
    try {
      await persist();
    } catch (error) {
      accessTokens.delete(tokenHash);
      throw error;
    }
    return token;
  }

  async function issueTokenPair(
    clientId: string,
    accessExpiresAt: number,
    refreshExpiresAt: number
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const accessToken = randomBytes(32).toString("base64url");
    const refreshToken = randomBytes(32).toString("base64url");
    const accessHash = hashSecret(accessToken);
    const refreshHash = hashSecret(refreshToken);

    accessTokens.set(accessHash, { expiresAt: accessExpiresAt });
    refreshTokens.set(refreshHash, { clientId, expiresAt: refreshExpiresAt });
    try {
      await persist();
    } catch (error) {
      accessTokens.delete(accessHash);
      refreshTokens.delete(refreshHash);
      throw error;
    }

    return { accessToken, refreshToken };
  }

  async function rotateRefreshToken(
    refreshToken: string,
    accessExpiresAt: number,
    refreshExpiresAt: number
  ): Promise<{ clientId: string; accessToken: string; refreshToken: string } | undefined> {
    const oldHash = hashSecret(refreshToken);
    const storedRefresh = refreshTokens.get(oldHash);
    if (!storedRefresh || Date.now() > storedRefresh.expiresAt) return undefined;

    const accessToken = randomBytes(32).toString("base64url");
    const newRefreshToken = randomBytes(32).toString("base64url");
    const accessHash = hashSecret(accessToken);
    const newRefreshHash = hashSecret(newRefreshToken);

    refreshTokens.delete(oldHash);
    accessTokens.set(accessHash, { expiresAt: accessExpiresAt });
    refreshTokens.set(newRefreshHash, {
      clientId: storedRefresh.clientId,
      expiresAt: refreshExpiresAt,
    });

    try {
      await persist();
    } catch (error) {
      refreshTokens.delete(newRefreshHash);
      accessTokens.delete(accessHash);
      refreshTokens.set(oldHash, storedRefresh);
      throw error;
    }

    return {
      clientId: storedRefresh.clientId,
      accessToken,
      refreshToken: newRefreshToken,
    };
  }

  function snapshot(): PersistedOAuthState {
    return {
      version: 1,
      accessTokens: [...accessTokens.entries()].map(([tokenHash, token]) => ({
        tokenHash,
        expiresAt: token.expiresAt,
      })),
      refreshTokens: [...refreshTokens.entries()].map(([tokenHash, token]) => ({
        tokenHash,
        clientId: token.clientId,
        expiresAt: token.expiresAt,
      })),
      registeredClients: [...registeredClients.values()].map((client) => ({
        ...client,
        redirectUris: [...client.redirectUris],
      })),
    };
  }

  function persist(): Promise<void> {
    const write = writeQueue.then(async () => {
      const directory = path.dirname(filePath);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      if (process.platform !== "win32") {
        const directoryStats = await fs.stat(directory);
        if ((directoryStats.mode & 0o077) !== 0) {
          throw new Error(
            `OAuth state directory is accessible by other users: ${directory}. ` +
              "Use a private directory or set OAUTH_STATE_PATH to a safer location."
          );
        }
      }

      const temporaryPath = path.join(directory, `.oauth-state-${process.pid}-${randomUUID()}.tmp`);
      const fileHandle = await fs.open(temporaryPath, "wx", 0o600);
      try {
        await fileHandle.writeFile(`${JSON.stringify(snapshot())}\n`, "utf8");
        await fileHandle.sync();
      } finally {
        await fileHandle.close();
      }

      try {
        await fs.chmod(temporaryPath, 0o600);
        await fs.rename(temporaryPath, filePath);
      } finally {
        await fs.unlink(temporaryPath).catch(() => undefined);
      }
    });

    writeQueue = write.catch(() => undefined);
    return write;
  }

  return {
    load,
    getClient,
    registerClient,
    verifyClientSecret,
    validateAccessToken,
    getRefreshToken,
    deleteRefreshToken,
    issueAccessToken,
    issueTokenPair,
    rotateRefreshToken,
  } as const;
}

export function hashClientSecret(secret: string): string {
  return hashSecret(secret);
}
