import { createPublicKey, verify } from "node:crypto";
import {
  accessSync,
  copyFileSync,
  mkdtempSync,
  rmSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { commandFailure } from "./release-diagnostics.mjs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { canonicalJson } from "@red-cup-engineering/json-services-section/canonical-json";
import { sha256Hex } from "@red-cup-engineering/cryptographic-computer-data-engineering-services-section/integrity";

export const WRANGLER_VERSION = "4.127.1";
export const CLOUDFLARE_COMPATIBILITY_DATE = "2026-08-29";
export const RELEASE_PROBE_USER_AGENT = "Mozilla/5.0 (compatible; KoiosNewsReleaseCheck/1.0)";
// Dependencies are resolved through Node, including PNPM's sibling supplier
// layout. A package need not have a private nested node_modules directory.
const require = createRequire(import.meta.url);
const WRANGLER_PACKAGE = require.resolve("wrangler/package.json");
export const WRANGLER = join(dirname(WRANGLER_PACKAGE), "bin/wrangler.js");
const WRANGLER_STATIC_CONFIG = fileURLToPath(
  new URL("../release/wrangler-static-assets.json", import.meta.url),
);
function verifyStaticAssetConfig() {
  const config = readJson(WRANGLER_STATIC_CONFIG, "Wrangler static asset config").value;
  if (!object(config) || !object(config.assets) ||
      Object.keys(config).length !== 1 ||
      Object.keys(config.assets).length !== 1 ||
      config.assets.not_found_handling !== "404-page") {
    throw new Error("Wrangler config must serve the candidate 404.html for missing routes");
  }
}

export const TARGET = Object.freeze({
  accountId: "337e54ee6dc7d488933f473204a6d89e",
  workerName: "koios-news-primary",
  hostname: "koios.news",
  routePattern: "koios.news/*",
  effect: "cloudflare-worker-static-publication",
});
const bytewise = (left, right) =>
  Buffer.compare(Buffer.from(left), Buffer.from(right));
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, expected, label) => {
  if (value !== expected) {
    throw new Error(`${label} must be ${JSON.stringify(expected)}`);
  }
};
const readJson = (path, label) => {
  const absolute = resolve(path), bytes = readFileSync(absolute);
  try {
    return { absolute, bytes, value: JSON.parse(bytes.toString("utf8")) };
  } catch {
    throw new Error(`${label} is not valid JSON: ${absolute}`);
  }
};
const probeBackoff = (attempt) =>
  new Promise((resolve) => setTimeout(resolve, Math.min(250 * (2 ** attempt), 2_000)));
function retryableProbeError(error) {
  return error?.name === "AbortError" || error?.name === "TimeoutError" ||
    ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN"].includes(error?.code) ||
    ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN"].includes(error?.cause?.code);
}
/** The pinned Wrangler runs under the carrier's own Node runtime, never whichever `node` a host PATH names first. */
export function runPinnedWrangler(program, args, { environment = process.env, stagingRoot } = {}) {
  // Wrangler writes state beside its configuration. Installed programs remain
  // immutable; each invocation receives a separate writable working directory.
  if(stagingRoot!==undefined)mkdirSync(stagingRoot,{recursive:true,mode:0o700});
  const workspace = mkdtempSync(join(stagingRoot??tmpdir(), "koios-wrangler-"));
  try {
    const invocation = [...args], config = invocation.indexOf("--config");
    if (config >= 0 && invocation[config + 1] === WRANGLER_STATIC_CONFIG) {
      verifyStaticAssetConfig();
      const writableConfig = join(workspace, "wrangler.json");
      copyFileSync(WRANGLER_STATIC_CONFIG, writableConfig);
      invocation[config + 1] = writableConfig;
    }
    return spawnSync(process.execPath, [program, ...invocation], { cwd: workspace,
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: environment });
  } finally { rmSync(workspace, { recursive: true, force: true }); }
}
/** The asynchronous scoped entrance retains staging if original custody is lost. */
export async function runPinnedWranglerScoped(program,args,{environment,stagingRoot,checkpoint}={}) {
  if(!environment||typeof checkpoint!=='function'||typeof stagingRoot!=='string'||resolve(stagingRoot)!==stagingRoot)
    throw new TypeError('Scoped Wrangler requires original environment, owner staging and execution custody');
  environment=Object.freeze({...environment});
  await checkpoint();mkdirSync(stagingRoot,{recursive:true,mode:0o700});
  const workspace=mkdtempSync(join(stagingRoot,'koios-wrangler-'));
  let failure;
  try {
    const invocation=[...args],config=invocation.indexOf('--config');
    if(config>=0&&invocation[config+1]===WRANGLER_STATIC_CONFIG){
      verifyStaticAssetConfig();const writableConfig=join(workspace,'wrangler.json');
      await checkpoint();copyFileSync(WRANGLER_STATIC_CONFIG,writableConfig);invocation[config+1]=writableConfig;
    }
    await checkpoint();
    const result=spawnSync(process.execPath,[program,...invocation],{cwd:workspace,encoding:'utf8',stdio:['ignore','pipe','pipe'],env:environment});
    await checkpoint();return result;
  } catch(error){failure=error;throw error;}
  finally {
    try{await checkpoint();rmSync(workspace,{recursive:true,force:true});}
    catch(error){if(failure&&!Object.is(failure,error))throw new AggregateError([failure,error],'Website command and staging custody both failed');throw error;}
  }
}
export function verifyPinnedWrangler() {
  const packageRoot = fileURLToPath(new URL("../", import.meta.url)),
    carrierPackagePath = join(packageRoot, "package.json"),
    packageJsonPath = WRANGLER_PACKAGE,
    carrierPackage = readJson(carrierPackagePath, "Cloudflare carrier package").value,
    packageJson = readJson(packageJsonPath, "installed Wrangler package").value;
  if (
    carrierPackage?.dependencies?.wrangler !== WRANGLER_VERSION ||
    packageJson?.version !== WRANGLER_VERSION ||
    packageJson?.bin?.wrangler !== "./bin/wrangler.js"
  ) throw new Error(`Wrangler must be the package-local pinned ${WRANGLER_VERSION} release`);
  accessSync(WRANGLER, constants.X_OK);
  const expected = realpathSync(join(dirname(packageJsonPath), packageJson.bin.wrangler));
  if (realpathSync(WRANGLER) !== expected) {
    throw new Error("package-local Wrangler executable does not resolve to its pinned package bin");
  }
  return Object.freeze({ version: WRANGLER_VERSION, packageSha256: sha256Hex(readFileSync(packageJsonPath)) });
}
const canonicalTimestamp = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
// Cloudflare deployment readbacks currently use RFC 3339 timestamps with
// microsecond precision. Keep operator-authored authority timestamps on the
// stricter canonical millisecond contract above, while accepting the
// provider's bounded UTC representation at the observation boundary.
const providerTimestamp = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value) &&
  Number.isFinite(Date.parse(value));
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex"),
  ED25519_FIELD = (1n << 255n) - 19n,
  ED25519_ORDER = (1n << 252n) + 27742317777372353535851937790883648493n;
const ED25519_SMALL_ORDER = new Set([
  "0100000000000000000000000000000000000000000000000000000000000000",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  "0000000000000000000000000000000000000000000000000000000000000080",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
  "0000000000000000000000000000000000000000000000000000000000000000",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
]);
const littleEndian = (bytes) => {
  let value = 0n;
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    value = value << 8n | BigInt(bytes[index]);
  }
  return value;
};
function encoded(value, size, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error(`${label} must be unpadded base64url`);
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== size || bytes.toString("base64url") !== value) {
    throw new Error(`${label} must encode ${size} bytes`);
  }
  return bytes;
}
function strictPoint(bytes, label) {
  const y = Buffer.from(bytes);
  y[31] &= 0x7f;
  if (
    littleEndian(y) >= ED25519_FIELD ||
    ED25519_SMALL_ORDER.has(bytes.toString("hex"))
  ) {
    throw new Error(
      `${label} is not a canonical non-small-order Ed25519 point`,
    );
  }
}
function exactShape(value, keys, label) {
  if (
    !object(value) || Object.keys(value).length !== keys.length ||
    keys.some((key) => !(key in value))
  ) throw new Error(`${label} has an invalid shape`);
}

function files(root) {
  const found = [];
  const visit = (directory) => {
    for (
      const entry of readdirSync(directory, { withFileTypes: true }).sort((
        a,
        b,
      ) => bytewise(a.name, b.name))
    ) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`candidate contains a symlink: ${path}`);
      }
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        found.push({ file: relative(root, path).split(sep).join("/"), path });
      } else throw new Error(`candidate contains a non-regular entry: ${path}`);
    }
  };
  visit(root);
  return found;
}
export function verifyCandidate(candidateDir) {
  const root = resolve(candidateDir);
  if (
    !existsSync(root) || !lstatSync(root).isDirectory() ||
    lstatSync(root).isSymbolicLink()
  ) throw new Error("candidate must be a regular directory");
  const manifestPath = join(root, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error("candidate lacks manifest.json");
  }
  const manifestBytes = readFileSync(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new Error(`candidate manifest is not valid JSON: ${manifestPath}`);
  }
  if (
    !object(manifest) ||
    manifest.kind !== "news-property.build-manifest/v1" ||
    !object(manifest.provenance) ||
    manifest.provenance.origin !== "https://koios.news"
  ) {
    throw new Error(
      "candidate manifest is not an engineering news-property build bound to https://koios.news",
    );
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    throw new Error("candidate manifest has no artifacts");
  }
  const expected = new Set();
  let prior;
  for (const artifact of manifest.artifacts) {
    if (
      !object(artifact) || typeof artifact.file !== "string" ||
      !/^[^/]+(?:\/[^/]+)*$/u.test(artifact.file) ||
      artifact.file.includes("..") || typeof artifact.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0
    ) throw new Error("candidate manifest contains an invalid artifact entry");
    if (prior !== undefined && bytewise(prior, artifact.file) >= 0) {
      throw new Error(
        "candidate manifest artifacts must be in strict bytewise path order",
      );
    }
    prior = artifact.file;
    if (expected.has(artifact.file)) {
      throw new Error(`candidate manifest lists ${artifact.file} twice`);
    }
    expected.add(artifact.file);
    const path = resolve(root, artifact.file);
    if (
      !path.startsWith(`${root}${sep}`) || !existsSync(path) ||
      !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()
    ) {
      throw new Error(
        `candidate artifact is missing or unsafe: ${artifact.file}`,
      );
    }
    const bytes = readFileSync(path);
    if (bytes.length !== artifact.bytes || sha256Hex(bytes) !== artifact.sha256) {
      throw new Error(
        `candidate artifact digest does not match: ${artifact.file}`,
      );
    }
  }
  const actual = new Set(
    files(root).map(({ file }) => file).filter((file) =>
      file !== "manifest.json"
    ),
  );
  if (
    actual.size !== expected.size ||
    [...actual].some((file) => !expected.has(file))
  ) throw new Error("candidate contains files not sealed by its manifest");
  return Object.freeze({
    root,
    manifestBytes,
    manifestDigest: sha256Hex(manifestBytes),
    artifactCount: expected.size,
    manifest,
  });
}
export function verifyBinding(bindingPath) {
  const binding = readJson(bindingPath, "release binding");
  if (
    !object(binding.value) ||
    binding.value.kind !== "koios.news.cloudflare-release-binding/v1"
  ) throw new Error("release binding has the wrong kind");
  for (const [key, value] of Object.entries(TARGET)) {
    exact(binding.value[key], value, `binding.${key}`);
  }
  return Object.freeze({ ...binding, digest: sha256Hex(binding.bytes) });
}
export function verifyGrant(
  grantPath,
  authorityKeysPath,
  candidate,
  binding,
  phase,
  now,
  baseline,
) {
  const source = readJson(grantPath, "release grant"), grant = source.value;
  if (`${canonicalJson(grant)}\n` !== source.bytes.toString("utf8")) {
    throw new Error("release grant is not canonical exact bytes");
  }
  exactShape(grant, [
    "admission",
    "expiresAt",
    "grantId",
    "issuedAt",
    "issuerKeyId",
    "kind",
    "scope",
    "signature",
  ], "release grant");
  if (
    grant.kind !== "koios.news.cloudflare-release-grant/v2" ||
    !/^[A-Za-z0-9_-]{16,128}$/u.test(grant.grantId ?? "")
  ) throw new Error("release grant has the wrong kind or id");
  if (
    !canonicalTimestamp(now) || !canonicalTimestamp(grant.issuedAt) ||
    !canonicalTimestamp(grant.expiresAt) ||
    Date.parse(grant.issuedAt) > Date.parse(now) ||
    Date.parse(grant.expiresAt) <= Date.parse(now)
  ) throw new Error("release grant is outside its explicit validity window");
  exactShape(
    grant.admission,
    ["kind", "verifiedProviderAuthority"],
    "release grant admission",
  );
  exact(
    grant.admission.kind,
    "local-operator-admission",
    "grant.admission.kind",
  );
  exact(
    grant.admission.verifiedProviderAuthority,
    false,
    "grant.admission.verifiedProviderAuthority",
  );
  exactShape(
    grant.scope,
    phase === "release"
      ? [
        "action",
        "baselineManifestSha256",
        "bindingSha256",
        "candidateManifestSha256",
        "target",
      ]
      : ["action", "bindingSha256", "candidateManifestSha256", "target"],
    "release grant scope",
  );
  exact(grant.scope.action, phase, "grant.scope.action");
  exact(
    grant.scope.candidateManifestSha256,
    candidate.manifestDigest,
    "grant.scope.candidateManifestSha256",
  );
  exact(grant.scope.bindingSha256, binding.digest, "grant.scope.bindingSha256");
  if (phase === "release") {
    exact(
      grant.scope.baselineManifestSha256,
      baseline?.manifestSha256,
      "grant.scope.baselineManifestSha256",
    );
  }
  exactShape(grant.scope.target, Object.keys(TARGET), "release grant target");
  for (const [key, value] of Object.entries(TARGET)) {
    exact(grant.scope.target[key], value, `grant.scope.target.${key}`);
  }
  const keys = readJson(authorityKeysPath, "release authority keys").value,
    publicKey = encoded(
      keys?.[grant.issuerKeyId],
      32,
      "release authority public key",
    ),
    signature = encoded(grant.signature, 64, "release grant signature");
  strictPoint(publicKey, "release authority public key");
  strictPoint(signature.subarray(0, 32), "release grant signature R");
  if (littleEndian(signature.subarray(32)) >= ED25519_ORDER) {
    throw new Error("release grant signature scalar is noncanonical");
  }
  const { signature: omitted, ...unsigned } = grant;
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey]),
    format: "der",
    type: "spki",
  });
  if (
    !verify(null, Buffer.from(canonicalJson(unsigned), "utf8"), key, signature)
  ) throw new Error("release grant signature is invalid");
  return Object.freeze({
    grant,
    digest: sha256Hex(source.bytes),
    consumptionId: `grant-${grant.grantId}`,
  });
}
export function authorizeSelf(candidate, binding, phase, baseline) {
  if (!["preview", "release"].includes(phase)) {
    throw new Error(`unknown self-authorization phase: ${phase}`);
  }
  const scope = Object.freeze({
    action: phase,
    ...(phase === "release"
      ? { baselineManifestSha256: baseline?.manifestSha256 }
      : {}),
    bindingSha256: binding.digest,
    candidateManifestSha256: candidate.manifestDigest,
    target: TARGET,
  });
  if (
    !/^[a-f0-9]{64}$/u.test(scope.candidateManifestSha256 ?? "") ||
    !/^[a-f0-9]{64}$/u.test(scope.bindingSha256 ?? "") ||
    (phase === "release" &&
      !/^[a-f0-9]{64}$/u.test(scope.baselineManifestSha256 ?? ""))
  ) {
    throw new Error(
      "self-authorization requires freshly computed candidate, binding, and release-baseline digests",
    );
  }
  const scopeDigest = sha256Hex(Buffer.from(canonicalJson(scope), "utf8")),
    admissionId = `self-${scopeDigest}`,
    grant = Object.freeze({
      admission: Object.freeze({
        kind: "automated-self-admission",
        verifiedProviderAuthority: false,
      }),
      admissionId,
      kind: "koios.news.cloudflare-release-self-admission/v1",
      scope,
    });
  return Object.freeze({
    grant,
    digest: sha256Hex(Buffer.from(`${canonicalJson(grant)}\n`, "utf8")),
    consumptionId: admissionId,
  });
}
export function verifyRollback(rollbackPath, binding) {
  const rollback = readJson(rollbackPath, "rollback binding").value;
  if (
    !object(rollback) ||
    rollback.kind !== "koios.news.cloudflare-rollback-binding/v1"
  ) throw new Error("rollback binding has the wrong kind");
  for (const [key, value] of Object.entries(TARGET)) {
    exact(rollback[key], value, `rollback.${key}`);
  }
  exact(rollback.bindingSha256, binding.digest, "rollback.bindingSha256");
  if (
    typeof rollback.priorVersionId !== "string" ||
    rollback.priorVersionId.length < 1
  ) throw new Error("rollback.priorVersionId is required");
  return Object.freeze(rollback);
}
/** Read the observed production manifest as evidence, never as a deployment input. */
export function verifyProductionBaseline(path, candidate) {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("release requires an explicit production baseline manifest");
  }
  const absolute = resolve(path);
  if (
    !existsSync(absolute) || lstatSync(absolute).isSymbolicLink() ||
    !lstatSync(absolute).isFile()
  ) throw new Error("production baseline must be a real regular file");
  const source = readJson(path, "production baseline manifest"),
    baseline = source.value;
  if (
    object(baseline) &&
    ["news-property.build-manifest/v1", "koios.news.static-publication-manifest/v1"].includes(baseline.kind)
  ) {
    if (!Array.isArray(baseline.artifacts) || baseline.artifacts.length === 0) {
      throw new Error("current production baseline has no sealed artifacts");
    }
    const required = new Set();
    for (const artifact of baseline.artifacts) {
      if (!object(artifact) || Object.keys(artifact).length !== 3 ||
        !["bytes", "file", "sha256"].every((key) => Object.hasOwn(artifact, key)) ||
        typeof artifact.file !== "string" || !/^[^/]+(?:\/[^/]+)*$/u.test(artifact.file) ||
        artifact.file.includes("..") || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 ||
        typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(artifact.sha256)) {
        throw new Error("current production baseline contains an unsafe sealed artifact");
      }
      if (required.has(artifact.file)) throw new Error(`production baseline lists ${artifact.file} twice`);
      required.add(artifact.file);
    }
    const offered = new Set(candidate.manifest.artifacts.map((artifact) => artifact.file));
    const missing = [...required].filter((file) => !offered.has(file));
    const redirects = new Map(configuredRedirects(candidate).map(({ source, target }) => [source, target]));
    const canonical = new Set((baseline.routes ?? []).map(({ url }) => {
      const pathname = new URL(url).pathname;
      return pathname === "/" ? "index.html" : `${pathname.slice(1)}index.html`;
    }));
    const lost = missing.filter((file) => {
      if (!file.endsWith("/index.html") || canonical.has(file)) return true;
      const source = `/${file.slice(0, -"index.html".length)}`;
      const target = redirects.get(source);
      return !target || !offered.has(`${target.slice(1)}index.html`);
    });
    if (lost.length > 0) throw new Error(`candidate drops ${lost.length} production routes without canonical redirects, beginning with ${lost.slice(0, 5).join(", ")}`);
    return Object.freeze({ manifestSha256: sha256Hex(source.bytes), artifactCount: required.size });
  }
  if (
    !object(baseline) ||
    baseline.kind !== "koios.static-publication-manifest" ||
    baseline.profile !== "cutover-candidate" ||
    baseline.authority !== "non-authoritative-cutover-candidate" ||
    baseline.canonicalOrigin !== "https://koios.news" ||
    !Array.isArray(baseline.artifacts) || baseline.artifacts.length === 0 ||
    !Number.isSafeInteger(baseline.routeCount) ||
    baseline.routeCount < 1 || baseline.routeCount > baseline.artifacts.length ||
    !Number.isSafeInteger(baseline.aliasCount) || baseline.aliasCount < 0
  ) {
    throw new Error(
      "production baseline is not a supported koios.static-publication-manifest",
    );
  }
  const required = new Set();
  for (const artifact of baseline.artifacts) {
    if (
      !object(artifact) ||
      Object.keys(artifact).length !== 5 ||
      !["bytes", "digest", "file", "mediaType", "route"].every((key) =>
        Object.hasOwn(artifact, key)
      ) ||
      typeof artifact.file !== "string" ||
      !/^[^/]+(?:\/[^/]+)*$/u.test(artifact.file) ||
      artifact.file.includes("..") ||
      typeof artifact.route !== "string" || artifact.route.length === 0 ||
      typeof artifact.mediaType !== "string" || artifact.mediaType.length === 0 ||
      !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 ||
      typeof artifact.digest !== "string" ||
      !/^ni:\/\/\/sha-256;[A-Za-z0-9_-]{43}$/u.test(artifact.digest)
    ) {
      throw new Error(
        "production baseline contains an unsafe artifact file path",
      );
    }
    if (required.has(artifact.file)) {
      throw new Error(`production baseline lists ${artifact.file} twice`);
    }
    required.add(artifact.file);
  }
  const offered = new Set(candidate.manifest.artifacts.map((artifact) => artifact.file));
  const missing = [...required].filter((file) => !offered.has(file));
  if (missing.length > 0) throw new Error(`candidate drops ${missing.length} production artifacts, beginning with ${missing.slice(0, 5).join(", ")}`);
  return Object.freeze({
    manifestSha256: sha256Hex(source.bytes),
    artifactCount: required.size,
  });
}
/**
 * Prove local release prerequisites without invoking Wrangler or inspecting
 * provider credentials. Cloudflare authentication remains provider-side
 * evidence and is intentionally outside this no-effect check.
 */
export function doctor(
  { candidateDir, bindingPath, productionBaselinePath, environment = process.env },
) {
  const candidate = verifyCandidate(candidateDir),
    binding = verifyBinding(bindingPath),
    toolchain = verifyPinnedWrangler(),
    accountConfiguration = environment.CLOUDFLARE_ACCOUNT_ID === undefined
      ? "missing"
      : environment.CLOUDFLARE_ACCOUNT_ID === TARGET.accountId
      ? "matches-fixed-target"
      : "does-not-match-fixed-target";
  const parity = productionBaselinePath === undefined
    ? {
      status: "not-assessed",
      reason:
        "release continuity requires an explicit observed production baseline",
    }
    : {
      status: "observed-predecessor-validated",
      ...verifyProductionBaseline(productionBaselinePath, candidate),
    };
  return Object.freeze({
    kind: "koios.news.cloudflare-release-doctor/v1",
    disposition: "no-effect",
    toolchain,
    candidate: {
      manifestSha256: candidate.manifestDigest,
      artifactCount: candidate.artifactCount,
    },
    binding: TARGET,
    bindingSha256: binding.digest,
    accountConfiguration: {
      environment: "CLOUDFLARE_ACCOUNT_ID",
      expectedAccountId: TARGET.accountId,
      status: accountConfiguration,
    },
    candidateParity: parity,
    cloudflareAuthorization: {
      status: "not-checked",
      reason:
        "Doctor does not invoke Wrangler, read credentials, or contact Cloudflare; it cannot establish or deny Cloudflare authentication or authorization.",
    },
  });
}
/** Create offline handoff evidence only; this is deliberately not release authority. */
export function enqueuePendingRelease({ candidateDir, bindingPath, productionBaselinePath, receiptOut }) {
  const candidate = verifyCandidate(candidateDir), binding = verifyBinding(bindingPath),
    baseline = verifyProductionBaseline(productionBaselinePath, candidate),
    routineRoot = resolve(candidateDir, ".."),
    routinePath = join(routineRoot, "routine-publication-receipt.json"),
    routine = readJson(routinePath, "routine publication receipt");
  if (lstatSync(routinePath).isSymbolicLink() || !lstatSync(routinePath).isFile() ||
    !object(routine.value) || routine.value.kind !== "koios.news.routine-publication-receipt/v1" ||
    routine.value.disposition !== "offline-news-property-candidate" ||
    routine.value.newsProperty?.package !== "@red-cup-engineering/news-property" ||
    routine.value.newsProperty?.output !== "public/" ||
    routine.value.newsProperty?.manifestSha256 !== candidate.manifestDigest ||
    routine.value.newsProperty?.artifactCount !== candidate.artifactCount) {
    throw new Error("pending release requires the adjacent offline routine-publication receipt");
  }
  return receiptPath(receiptOut, {
    kind: "koios.news.cloudflare-pending-release-envelope/v1",
    disposition: "no-effect-no-release-authority",
    candidateManifestSha256: candidate.manifestDigest,
    bindingSha256: binding.digest,
    productionBaselineManifestSha256: baseline.manifestSha256,
    routinePublicationReceiptSha256: sha256Hex(routine.bytes),
    limitations: ["This envelope grants no Cloudflare preview, release, rollback, or provider authority."],
  });
}
const command = (program, args) =>
  Object.freeze({
    program,
    args: Object.freeze(args),
    credentialPolicy:
      "Cloudflare credentials are read only by the child process; this carrier never prints environment values or command output.",
  });
function receiptPath(path, receipt) {
  if (!path) return Object.freeze(receipt);
  const target = resolve(path);
  if (existsSync(target)) {
    throw new Error(`refusing to overwrite immutable receipt: ${target}`);
  }
  mkdirSync(resolve(target, ".."), { recursive: true });
  writeFileSync(target, `${JSON.stringify(receipt, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  return Object.freeze({ ...receipt, receiptPath: target });
}
function deploy(candidate, name, route) {
  verifyStaticAssetConfig();
  return command(WRANGLER, [
    "deploy",
    "--config",
    WRANGLER_STATIC_CONFIG,
    "--name",
    name,
    "--compatibility-date",
    CLOUDFLARE_COMPATIBILITY_DATE,
    "--assets",
    candidate.root,
    ...(route ? ["--route", route] : []),
  ]);
}
function previewReceipt(path, candidate, binding) {
  const preview = readJson(path, "preview receipt"), receipt = preview.value;
  if (
    !object(receipt) ||
    receipt.kind !== "koios.news.cloudflare-preview-receipt/v1"
  ) throw new Error("release requires a preview probe receipt");
  exact(
    receipt.candidateManifestSha256,
    candidate.manifestDigest,
    "preview receipt candidate",
  );
  exact(receipt.bindingSha256, binding.digest, "preview receipt binding");
  if (!object(receipt.binding)) {
    throw new Error("preview receipt lacks its full target binding");
  }
  for (const [key, value] of Object.entries(TARGET)) {
    exact(receipt.binding[key], value, `preview receipt binding.${key}`);
  }
  if (!object(receipt.probe) || receipt.probe.accepted !== true) {
    throw new Error(
      "release requires an accepted preview receipt for this exact candidate and binding",
    );
  }
  safeUrl(receipt.probe.url);
  exact(
    receipt.probe.candidateManifestSha256,
    candidate.manifestDigest,
    "preview probe candidate",
  );
  exact(receipt.probe.bindingSha256, binding.digest, "preview probe binding");
  exact(
    receipt.probe.manifestSha256,
    candidate.manifestDigest,
    "preview probe manifest",
  );
  exact(receipt.probe.notFound?.status, 404, "preview missing-route status");
  exact(receipt.probe.notFound?.sha256, sha256Hex(readFileSync(join(candidate.root, "404.html"))), "preview missing-route body");
  if (!Array.isArray(receipt.probe.artifacts)) {
    throw new Error("preview probe lacks representative sealed assets");
  }
  const selected = previewReceivingArtifacts(candidate);
  const observed = new Map();
  for (const entry of receipt.probe.artifacts) {
    if (!object(entry) || typeof entry.file !== "string" || observed.has(entry.file)) {
      throw new Error("preview probe has duplicate or invalid evidence");
    }
    observed.set(entry.file, entry);
  }
  for (const expected of selected) {
    const entry = observed.get(expected.file);
    if (!entry || entry.sha256 !== expected.sha256 || entry.bytes !== expected.bytes) {
      throw new Error(`preview probe did not receive mandatory sealed route: ${expected.file}`);
    }
  }
  const redirects = configuredRedirects(candidate);
  if (!Array.isArray(receipt.probe.redirects) || receipt.probe.redirects.length !== redirects.length ||
      redirects.some((rule, index) => receipt.probe.redirects[index]?.source !== rule.source ||
        receipt.probe.redirects[index]?.target !== rule.target || receipt.probe.redirects[index]?.status !== 301)) {
    throw new Error("preview probe does not establish the sealed redirects");
  }
  return sha256Hex(preview.bytes);
}
export function plan(
  {
    phase = "plan",
    candidateDir,
    bindingPath,
    grantPath,
    authorityKeysPath,
    now,
    rollbackPath,
    previewReceiptPath,
    productionBaselinePath,
  },
) {
  const candidate = verifyCandidate(candidateDir),
    binding = verifyBinding(bindingPath);
  const grantTemplate = {
    admission: {
      kind: "local-operator-admission",
      verifiedProviderAuthority: false,
    },
    expiresAt: "<future-canonical-UTC-instant>",
    grantId: "<unique-operator-supplied-id>",
    issuedAt: "<canonical-UTC-instant>",
    issuerKeyId: "<independently-configured-key-id>",
    kind: "koios.news.cloudflare-release-grant/v2",
    scope: {
      action: "<preview-or-release>",
      bindingSha256: binding.digest,
      candidateManifestSha256: candidate.manifestDigest,
      target: TARGET,
    },
    signature: "<Ed25519-signature-over-canonical-unsigned-object>",
  };
  const base = {
    kind: "koios.news.cloudflare-release-plan/v2",
    phase,
    candidate: {
      manifestSha256: candidate.manifestDigest,
      artifactCount: candidate.artifactCount,
    },
    binding: TARGET,
    bindingSha256: binding.digest,
    immutableReceipt: true,
    accountVerification: {
      environment: "CLOUDFLARE_ACCOUNT_ID",
      expectedAccountId: TARGET.accountId,
    },
    requiredAdmissions: {
      grant: grantTemplate,
      rollback: {
        kind: "koios.news.cloudflare-rollback-binding/v1",
        ...TARGET,
        bindingSha256: binding.digest,
        priorVersionId: "<current-production-version-id>",
      },
    },
  };
  if (phase === "plan") {
    return Object.freeze({
      ...base,
      disposition: "dry-run",
      commands: [
        deploy(
          candidate,
          `${TARGET.workerName}-preview-${
            candidate.manifestDigest.slice(0, 12)
          }`,
        ),
        deploy(candidate, TARGET.workerName, TARGET.routePattern),
        command(WRANGLER, [
          "rollback",
          "<priorVersionId>",
          "--name",
          TARGET.workerName,
        ]),
      ],
      refusal:
        "No Cloudflare process is started. Preview and release require separate signed, exact-action grants and durable one-use consumption.",
    });
  }
  if (!["preview", "release"].includes(phase)) {
    throw new Error(`unknown phase: ${phase}`);
  }
  const baseline = phase === "release"
    ? verifyProductionBaseline(productionBaselinePath, candidate)
    : undefined;
  const authority = verifyGrant(
    grantPath,
    authorityKeysPath,
    candidate,
    binding,
    phase,
    now,
    baseline,
  );
  if (phase === "preview") {
    return Object.freeze({
      ...base,
      disposition: "preview-authorized",
      grantId: authority.grant.grantId,
      grantDigest: authority.digest,
      consumptionId: authority.consumptionId,
      commands: [
        deploy(
          candidate,
          `${TARGET.workerName}-preview-${
            candidate.manifestDigest.slice(0, 12)
          }`,
        ),
      ],
      next:
        "Use the create-only probe command with an explicit safe HTTPS preview URL before release.",
    });
  }
  const rollback = verifyRollback(rollbackPath, binding),
    probeDigest = previewReceipt(previewReceiptPath, candidate, binding);
  return Object.freeze({
    ...base,
    disposition: "release-authorized",
    grantId: authority.grant.grantId,
    grantDigest: authority.digest,
    consumptionId: authority.consumptionId,
    previewReceiptSha256: probeDigest,
    productionBaselineManifestSha256: baseline.manifestSha256,
    rollback: { priorVersionId: rollback.priorVersionId },
    commands: [
      deploy(candidate, TARGET.workerName, TARGET.routePattern),
      command(WRANGLER, [
        "rollback",
        rollback.priorVersionId,
        "--name",
        TARGET.workerName,
      ]),
    ],
  });
}
export function planSelfAuthorized(
  {
    phase,
    candidateDir,
    bindingPath,
    rollbackPath,
    previewReceiptPath,
    productionBaselinePath,
  },
) {
  const candidate = verifyCandidate(candidateDir),
    binding = verifyBinding(bindingPath);
  if (!["preview", "release"].includes(phase)) {
    throw new Error(`unknown self-authorization phase: ${phase}`);
  }
  const baseline = phase === "release"
    ? verifyProductionBaseline(productionBaselinePath, candidate)
    : undefined;
  const authority = authorizeSelf(
    candidate,
    binding,
    phase,
    baseline,
  );
  const base = {
    kind: "koios.news.cloudflare-release-plan/v2",
    phase,
    candidate: {
      manifestSha256: candidate.manifestDigest,
      artifactCount: candidate.artifactCount,
    },
    binding: TARGET,
    bindingSha256: binding.digest,
    immutableReceipt: true,
    accountVerification: {
      environment: "CLOUDFLARE_ACCOUNT_ID",
      expectedAccountId: TARGET.accountId,
    },
    requiredAdmissions: {
      grant: authority.grant,
      rollback: {
        kind: "koios.news.cloudflare-rollback-binding/v1",
        ...TARGET,
        bindingSha256: binding.digest,
        priorVersionId: "<current-production-version-id>",
      },
    },
  };
  if (phase === "preview") {
    return Object.freeze({
      ...base,
      disposition: "preview-authorized",
      authorizedBy: "automated-self-admission",
      grantId: authority.consumptionId,
      grantDigest: authority.digest,
      consumptionId: authority.consumptionId,
      commands: [
        deploy(
          candidate,
          `${TARGET.workerName}-preview-${
            candidate.manifestDigest.slice(0, 12)
          }`,
        ),
      ],
      next:
        "Use the create-only probe command with an explicit safe HTTPS preview URL before release.",
    });
  }
  const rollback = verifyRollback(rollbackPath, binding),
    probeDigest = previewReceipt(previewReceiptPath, candidate, binding);
  return Object.freeze({
    ...base,
    disposition: "release-authorized",
    authorizedBy: "automated-self-admission",
    grantId: authority.consumptionId,
    grantDigest: authority.digest,
    consumptionId: authority.consumptionId,
    previewReceiptSha256: probeDigest,
    productionBaselineManifestSha256: baseline.manifestSha256,
    rollback: { priorVersionId: rollback.priorVersionId },
    commands: [
      deploy(candidate, TARGET.workerName, TARGET.routePattern),
      command(WRANGLER, [
        "rollback",
        rollback.priorVersionId,
        "--name",
        TARGET.workerName,
      ]),
    ],
  });
}
function consume(replayRoot, releasePlan) {
  if (typeof replayRoot !== "string" || replayRoot.length === 0) {
    throw new Error("durable replay root is required before execution");
  }
  const root = resolve(replayRoot);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) {
    throw new Error("replay root must be a regular directory");
  }
  const path = join(root, `${releasePlan.consumptionId}.json`);
  let fd;
  try {
    fd = openSync(path, "wx", 0o600);
    const bytes = Buffer.from(`${
      JSON.stringify({
        kind: "koios.news.cloudflare-release-authority-use/v1",
        consumptionId: releasePlan.consumptionId,
        grantDigest: releasePlan.grantDigest,
        phase: releasePlan.phase,
        candidateManifestSha256: releasePlan.candidate.manifestSha256,
        bindingSha256: releasePlan.bindingSha256,
        ...(releasePlan.phase === "release"
          ? {
            productionBaselineManifestSha256:
              releasePlan.productionBaselineManifestSha256,
          }
          : {}),
      })
    }\n`);
    writeSync(fd, bytes);
    fsyncSync(fd);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error("release authority use has already been consumed");
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const directory = openSync(root, "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
  return path;
}
function deploymentReadback(name) {
  return command(WRANGLER, ["deployments", "list", "--name", name, "--json"]);
}
function providerDeployments(result, { allowAbsent = false } = {}) {
  if (!result || result.status !== 0 || typeof result.stdout !== "string") {
    if (allowAbsent && result?.status === 1 && typeof result.stderr === "string" && /\[code:\s*10007\]/u.test(result.stderr)) return [];
    throw new Error("Cloudflare deployment readback failed");
  }
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch {
    throw new Error("Cloudflare deployment readback was not machine-readable JSON");
  }
  const deployments = Array.isArray(parsed) ? parsed : parsed?.deployments;
  if (!Array.isArray(deployments)) throw new Error("Cloudflare deployment readback is not a deployment list");
  for (const entry of deployments) {
    if (!object(entry) || typeof entry.id !== "string" || entry.id.length < 1 ||
      !providerTimestamp(entry.created_on) || !Array.isArray(entry.versions) ||
      entry.versions.length < 1 || entry.versions.some((version) =>
        !object(version) || typeof version.version_id !== "string" || version.version_id.length < 1 ||
        typeof version.percentage !== "number" || !Number.isFinite(version.percentage))) {
      throw new Error("Cloudflare deployment readback contains an invalid deployment");
    }
  }
  return deployments;
}
/**
 * The production worker's current exact version, read back from Cloudflare: the
 * rollback target a release binds before it deploys. It is the latest
 * deployment's one 100 percent version; a split or empty readback is refused.
 */
export function observeProductionVersion({ environment = process.env, executor } = {}) {
  exact(environment.CLOUDFLARE_ACCOUNT_ID, TARGET.accountId, "CLOUDFLARE_ACCOUNT_ID");
  if (executor === undefined) verifyPinnedWrangler();
  const run = executor ?? runPinnedWrangler,
    readback = deploymentReadback(TARGET.workerName),
    deployments = providerDeployments(run(readback.program, readback.args, { environment }));
  return productionVersionOf(deployments);
}
function productionVersionOf(deployments) {
  const latest = [...deployments].sort((a, b) => Date.parse(a.created_on) - Date.parse(b.created_on)).at(-1),
    active = latest?.versions.filter(({ percentage }) => percentage === 100) ?? [];
  if (!latest || latest.versions.length !== 1 || active.length !== 1) throw new Error("current production deployment is not one exact 100 percent version");
  return Object.freeze({ deploymentId: latest.id, versionId: active[0].version_id, createdOn: latest.created_on });
}
export async function observeProductionVersionScoped({environment,executor,checkpoint,stagingRoot}={}) {
  if(typeof checkpoint!=='function'||!environment)throw new TypeError('Scoped rollback readback requires original environment and custody');
  environment=Object.freeze({...environment});
  await checkpoint();exact(environment.CLOUDFLARE_ACCOUNT_ID,TARGET.accountId,'CLOUDFLARE_ACCOUNT_ID');
  if(executor===undefined||executor===runPinnedWrangler||executor===runPinnedWranglerScoped)verifyPinnedWrangler();
  const readback=deploymentReadback(TARGET.workerName),run=executor??runPinnedWranglerScoped;
  const result=await run(readback.program,readback.args,{environment,checkpoint,stagingRoot});
  await checkpoint();return productionVersionOf(providerDeployments(result));
}
function observedProviderDeployment(before, after) {
  const priorIds = new Set(before.map(({ id }) => id));
  const created = after.filter(({ id }) => !priorIds.has(id));
  if (created.length !== 1) throw new Error("Cloudflare readback did not identify exactly one new deployment");
  const entry = created[0], active = entry.versions.filter(({ percentage }) => percentage === 100);
  if (entry.versions.length !== 1 || active.length !== 1) {
    throw new Error("new Cloudflare deployment is not one exact 100 percent version");
  }
  return Object.freeze({ deploymentId: entry.id, versionId: active[0].version_id, createdOn: entry.created_on });
}
function observationUrl(value, phase) {
  if (phase === "preview") return safeUrl(value);
  let url;
  try { url = new URL(value); } catch { throw new Error("release observation URL must be https://koios.news/"); }
  if (url.href !== "https://koios.news/") {
    throw new Error("release observation URL must be exactly https://koios.news/");
  }
  return url;
}
async function awaitServedManifest(base, candidate, fetchImpl, {
  timeoutMs = 90_000, intervalMs = 2_000,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  do {
    try {
      const bytes = await fetchExact(base, "manifest.json", candidate.manifestBytes.length, fetchImpl);
      if (bytes.equals(candidate.manifestBytes)) return bytes;
      lastError = new Error("served manifest bytes do not match the exact candidate");
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, deadline - Date.now())));
  } while (true);
  throw new Error(`candidate manifest did not become observable within ${timeoutMs}ms: ${lastError.message}`);
}
async function observeExactDeployment(candidate, binding, url, phase, fetchImpl) {
  const base = observationUrl(url, phase),
    manifestBytes = await awaitServedManifest(base, candidate, fetchImpl),
    notFound = await fetchMissingRoute(base, candidate, fetchImpl),
    artifacts = new Array(candidate.manifest.artifacts.length);
  let next = 0;
  async function observeNext() {
    while (next < artifacts.length) {
      const index = next++, artifact = candidate.manifest.artifacts[index];
      if (artifact.file === "_headers" || artifact.file === "_redirects") {
        artifacts[index] = { ...artifact, observation: "cloudflare-deployment-config-not-public-asset" };
        continue;
      }
      if (phase === "release" && artifact.file === "robots.txt") {
        const bytes = await fetchObserved(base, artifact.file, 64 * 1024, fetchImpl);
        artifacts[index] = { ...artifact, observation: "cloudflare-managed-content", observedSha256: sha256Hex(bytes), observedBytes: bytes.length };
        continue;
      }
      await awaitSealedAsset(base, candidate, artifact, fetchImpl);
      artifacts[index] = { file: artifact.file, sha256: artifact.sha256, bytes: artifact.bytes };
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, artifacts.length) }, observeNext));
  const redirects = await observeRedirects(base, candidate, fetchImpl);
  return Object.freeze({ accepted: true, url: base.toString(), candidateManifestSha256: candidate.manifestDigest,
    bindingSha256: binding.digest, manifestSha256: sha256Hex(manifestBytes), notFound, artifacts, redirects });
}
export async function auditProduction(
  { candidateDir, bindingPath, receiptOut, fetchImpl = fetch, checkpoint = async()=>{} },
) {
  await checkpoint();
  if (!receiptOut || existsSync(resolve(receiptOut))) {
    throw new Error("a new immutable production audit receipt path is required");
  }
  const candidate = verifyCandidate(candidateDir),
    binding = verifyBinding(bindingPath),
    probe = await observeExactDeployment(candidate, binding, "https://koios.news/", "release", fetchImpl);
  await checkpoint();return receiptPath(receiptOut, {
    kind: "koios.news.cloudflare-production-observation-receipt/v1",
    candidateManifestSha256: candidate.manifestDigest,
    binding: TARGET,
    bindingSha256: binding.digest,
    probe,
  });
}
export async function executeObservedAuthorized(
  { phase, plan: releasePlan, receiptOut, replayRoot, environment = process.env,
    executor, url, fetchImpl = fetch, checkpoint = async()=>{}, stagingRoot },
) {
  environment=Object.freeze({...environment});
  await checkpoint();
  const disposition = phase === "preview" ? "preview-authorized" : phase === "release" ? "release-authorized" : undefined;
  if (!releasePlan || releasePlan.phase !== phase || releasePlan.disposition !== disposition) throw new Error("only an exact-phase authorized preview or release plan can execute");
  if (!receiptOut || existsSync(resolve(receiptOut))) throw new Error("a new immutable receipt path is required before execution");
  exact(environment.CLOUDFLARE_ACCOUNT_ID, TARGET.accountId, "CLOUDFLARE_ACCOUNT_ID");
  const deployment = releasePlan.commands?.[0];
  exact(deployment?.program, WRANGLER, "authorized deployment executable");
  const toolchain = executor === undefined || executor === runPinnedWrangler || executor === runPinnedWranglerScoped ? verifyPinnedWrangler() : Object.freeze({ version: WRANGLER_VERSION, injectedExecutor: true });
  const nameIndex = deployment.args.indexOf("--name"), deployedName = deployment.args[nameIndex + 1],
    expectedName = phase === "release" ? TARGET.workerName : `${TARGET.workerName}-preview-${releasePlan.candidate.manifestSha256.slice(0, 12)}`;
  exact(deployedName, expectedName, "authorized deployment worker name");
  const run = executor ?? runPinnedWrangler,readbackCommand = deploymentReadback(deployedName);
  await checkpoint();
  const before = providerDeployments(await run(readbackCommand.program, readbackCommand.args, { environment,checkpoint,stagingRoot }), { allowAbsent: phase === "preview" });
  await checkpoint();const authorityUsePath = consume(replayRoot, releasePlan);
  await checkpoint();const deployed = await run(deployment.program, deployment.args, { environment,checkpoint,stagingRoot });
  await checkpoint();
  if (!deployed || deployed.status !== 0) throw commandFailure({
    result: deployed, phase, environment, receiptOut,
    attributes: { "koios.release.authority_use.path": authorityUsePath,
      "koios.release.candidate.sha256": releasePlan.candidate.manifestSha256,
      "koios.release.worker.name": deployedName },
  });
  const after = providerDeployments(await run(readbackCommand.program, readbackCommand.args, { environment,checkpoint,stagingRoot })),
    provider = observedProviderDeployment(before, after);
  await checkpoint();
  const candidate = { root: deployment.args[deployment.args.indexOf("--assets") + 1], manifestDigest: releasePlan.candidate.manifestSha256, manifestBytes: readFileSync(join(deployment.args[deployment.args.indexOf("--assets") + 1], "manifest.json")), manifest: verifyCandidate(deployment.args[deployment.args.indexOf("--assets") + 1]).manifest };
  const binding = { digest: releasePlan.bindingSha256 };
  writeFileSync(`${resolve(receiptOut)}.deployment.json`, JSON.stringify({phase, provider, candidateManifestSha256: candidate.manifestDigest, uploadedArtifacts: candidate.manifest.artifacts.length, stdout: deployed.stdout}, null, 2));
  const probe = await observeExactDeployment(candidate, binding, url, phase, fetchImpl);
  await checkpoint();return receiptPath(receiptOut, {
    kind: phase === "preview"
      ? "koios.news.cloudflare-preview-deployment-receipt/v1"
      : "koios.news.cloudflare-release-receipt/v1",
    candidateManifestSha256: releasePlan.candidate.manifestSha256,
    binding: TARGET,
    bindingSha256: releasePlan.bindingSha256,
    grantId: releasePlan.grantId,
    grantDigest: releasePlan.grantDigest,
    authorityUsePath,
    ...(phase === "release"
      ? {
        previewReceiptSha256: releasePlan.previewReceiptSha256,
        productionBaselineManifestSha256:
          releasePlan.productionBaselineManifestSha256,
        rollback: releasePlan.rollback,
      }
      : {}),
    deployment: { command: deployment.args, readback: { command: readbackCommand.args, ...provider } },
    toolchain,
    probe,
  });
}
function safeUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "probe URL must be an absolute HTTPS Cloudflare preview URL",
    );
  }
  if (
    url.protocol !== "https:" || url.username || url.password || url.port ||
    url.search || url.hash || !url.hostname.endsWith(".workers.dev") ||
    url.hostname === "workers.dev" || !url.pathname.endsWith("/")
  ) {
    throw new Error(
      "probe URL must be an HTTPS *.workers.dev directory URL without credentials, port, query, or fragment",
    );
  }
  return url;
}
function servedAssetPath(file) {
  if (file === "index.html") return "";
  if (file === "404.html") return "404";
  if (file.endsWith(".html") && !file.endsWith("/index.html")) return file.slice(0, -".html".length);
  return file.endsWith("/index.html")
    ? file.slice(0, -"index.html".length)
    : file;
}
async function fetchProbeResponse(url, fetchImpl, expectedPresent = false) {
  const attempts = expectedPresent ? 6 : 3;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { "user-agent": RELEASE_PROBE_USER_AGENT },
        redirect: "error", signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      if (attempt === attempts - 1 || error.cause?.code === "ERR_INVALID_REDIRECT") throw error;
      await probeBackoff(attempt);
      continue;
    }
    if (!([502, 503, 504].includes(response?.status) || (expectedPresent && response?.status === 404)) || attempt === attempts - 1) return response;
    await response.body?.cancel?.();
    await probeBackoff(attempt);
  }
}
async function fetchObserved(base, file, maximumBytes, fetchImpl) {
  const url = new URL(servedAssetPath(file), base);
  let lastError;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const response = await fetchProbeResponse(url, fetchImpl, true);
      if (!response?.ok) throw new Error(`probe fetch failed for ${file}: HTTP ${response?.status ?? "unknown"}`);
      if (typeof response.url === "string" && response.url !== "" && response.url !== url.href) throw new Error(`probe response URL changed for ${file}`);
      const contentLength = response.headers?.get?.("content-length");
      if (contentLength !== null && contentLength !== undefined && Number(contentLength) > maximumBytes) throw new Error(`probe response exceeds the provider-managed byte bound for ${file}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > maximumBytes) throw new Error(`probe response exceeds the provider-managed byte bound for ${file}`);
      return bytes;
    } catch (error) {
      if (!retryableProbeError(error)) throw error;
      lastError = error;
    }
    await probeBackoff(attempt);
  }
  throw lastError;
}
async function fetchExact(base, file, expectedBytes, fetchImpl) {
  // Workers Static Assets canonicalizes directory indexes and redirects
  // requests ending in `/index.html`. Probe the canonical route directly so
  // redirect refusal remains meaningful instead of rejecting correct assets.
  const servedPath = servedAssetPath(file), url = new URL(servedPath, base);
  let lastError;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const response = await fetchProbeResponse(url, fetchImpl, true);
      if (!response?.ok) {
        throw new Error(
          `probe fetch failed for ${file}: HTTP ${response?.status ?? "unknown"}`,
        );
      }
      if (
        typeof response.url === "string" && response.url !== "" &&
        response.url !== url.href
      ) throw new Error(`probe response URL changed for ${file}`);
      const contentLength = response.headers?.get?.("content-length");
      if (
        contentLength !== null && contentLength !== undefined &&
        Number(contentLength) > expectedBytes
      ) {
        throw new Error(
          `probe response exceeds the sealed byte length for ${file}`,
        );
      }
      let bytes;
      if (response.body?.getReader) {
        const reader = response.body.getReader(), chunks = [];
        let total = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > expectedBytes) {
              throw new Error(
                `probe response exceeds the sealed byte length for ${file}`,
              );
            }
            chunks.push(Buffer.from(value));
          }
        } finally {
          reader.releaseLock();
        }
        bytes = Buffer.concat(chunks, total);
      } else bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length !== expectedBytes) {
        throw new Error(`probe response byte length does not match for ${file}`);
      }
      return bytes;
    } catch (error) {
      if (!retryableProbeError(error)) throw error;
      lastError = error;
    }
    await probeBackoff(attempt);
  }
  throw lastError;
}
async function awaitSealedAsset(base, candidate, artifact, fetchImpl) {
  const expected = readFileSync(join(candidate.root, artifact.file));
  let lastError;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const bytes = await fetchExact(base, artifact.file, artifact.bytes, fetchImpl);
      if (bytes.equals(expected)) return;
      lastError = new Error(`served sealed artifact bytes do not match: ${artifact.file}`);
    } catch (error) {
      if (!error.message.startsWith("probe response byte length does not match for ") &&
          !error.message.startsWith("probe response exceeds the sealed byte length for ")) throw error;
      lastError = error;
    }
    if (attempt < 5) await probeBackoff(attempt);
  }
  throw lastError;
}
function configuredRedirects(candidate) {
  const file = join(candidate.root, "_redirects");
  if (!existsSync(file)) return [];
  const seen = new Set();
  const rules = readFileSync(file, "utf8").trim().split("\n").map((line) => {
    const parts = line.split(" ");
    if (parts.length !== 3 || parts[2] !== "301" ||
        !/^\/(?!\/)[a-z0-9/-]+$/u.test(parts[0]) ||
        !/^\/(?!\/)[a-z0-9/-]+\/$/u.test(parts[1]) ||
        seen.has(parts[0])) throw new Error(`invalid sealed redirect rule: ${line}`);
    seen.add(parts[0]);
    return { source: parts[0], target: parts[1] };
  });
  if (rules.length > 2_000) throw new Error("sealed redirects exceed the static redirect limit");
  return rules;
}
async function observeRedirects(base, candidate, fetchImpl) {
  const rules = configuredRedirects(candidate), observed = new Array(rules.length);
  let next = 0;
  async function observeNext() {
    while (next < rules.length) {
      const index = next++, { source, target } = rules[index];
      const url = new URL(source, base), expected = new URL(target, base).href;
      let lastStatus, lastLocation;
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          const response = await fetchImpl(url, { headers: { "user-agent": RELEASE_PROBE_USER_AGENT },
            redirect: "manual", signal: AbortSignal.timeout(15_000) });
          lastStatus = response?.status;
          lastLocation = response?.headers?.get?.("location");
          await response.body?.cancel?.();
          if (response.url === url.href && lastStatus === 301 &&
              lastLocation && new URL(lastLocation, url).href === expected) {
            observed[index] = { source, target, status: 301 };
            break;
          }
        } catch (error) {
          if (!retryableProbeError(error)) throw error;
        }
        if (attempt < 5) await probeBackoff(attempt);
      }
      if (!observed[index]) throw new Error(`sealed redirect was not served: ${source} -> ${target}; HTTP ${lastStatus}, location ${lastLocation}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, rules.length) }, observeNext));
  return observed;
}
async function fetchMissingRoute(base, candidate, fetchImpl) {
  const url = new URL(`__koios_missing_${candidate.manifestDigest.slice(0, 16)}/`, base);
  const expected = readFileSync(join(candidate.root, "404.html"));
  let lastError;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const response = await fetchProbeResponse(url, fetchImpl);
      if (response.status === 404 && response.url === url.href) {
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.equals(expected)) {
          return { status: 404, url: url.href, sha256: sha256Hex(bytes), bytes: bytes.length };
        }
        lastError = new Error("missing route did not serve the candidate 404.html");
      } else {
        await response.body?.cancel?.();
        lastError = new Error(`missing route did not serve the expected 404 status: HTTP ${response.status}`);
      }
    } catch (error) {
      if (!retryableProbeError(error)) throw error;
      lastError = error;
    }
    if (attempt < 5) await probeBackoff(attempt);
  }
  throw lastError;
}
/**
 * Source-owned preview assurance: exact public routes matter more than three
 * arbitrary manifest indices. Keep the existing representative sample, and
 * additionally receive the home, correction intake, a real article and every
 * withdrawn notice (when the original published build contains any).
 *
 * Only the original sealed candidate's paths and bytes qualify. The probe
 * adds no route, article, editor, authority or independent store.
 */
function previewReceivingArtifacts(candidate) {
  const listed = candidate.manifest.artifacts.filter(({ file }) =>
    file !== "_headers" && file !== "_redirects");
  const byFile = new Map(listed.map(entry => [entry.file, entry]));
  for (const required of ["index.html", "corrections/index.html"]) {
    if (!byFile.has(required)) throw new Error(`preview candidate lacks public receiving route: ${required}`);
  }
  const articles = listed.filter(({ file }) => /^posts\/[a-z0-9-]+\/index\.html$/u.test(file));
  const withdrawn = [];
  let firstPublished;
  for (const entry of articles) {
    const html = readFileSync(join(candidate.root, entry.file), "utf8");
    if (!/<h1>Article unavailable<\/h1>/u.test(html)) {
      firstPublished ??= entry;
      continue;
    }
    const canonical = `https://koios.news/${entry.file.slice(0, -"index.html".length)}`;
    if (!html.includes('<a class="skip-to-content" href="#main-content">Skip to content</a>')
      || !html.includes('<main id="main-content" tabindex="-1" role="main">')
      || (html.match(/id="main-content"/gu) ?? []).length !== 1
      || !html.includes('<meta name="robots" content="noindex, follow">')
      || !html.includes(`<link rel="canonical" href="${canonical}">`)
      || !html.includes('href="/corrections/"')
      || !html.includes('href="/archive/"')
      || /data-slot=|data-aa=|\/assets\/house-ad\.js|<iframe|NewsArticle/u.test(html)) {
      throw new Error(`preview withdrawn-notice assurance failed: ${entry.file}`);
    }
    withdrawn.push(entry);
  }
  const candidates = [
    listed[0], listed[Math.floor(listed.length / 2)], listed.at(-1),
    byFile.get("index.html"), byFile.get("corrections/index.html"),
    firstPublished, ...withdrawn,
  ].filter(Boolean);
  return Object.freeze([...new Map(candidates.map(entry => [entry.file, entry])).values()]);
}

export async function acceptPreviewProbe(
  { candidateDir, bindingPath, url, receiptOut, fetchImpl = fetch, checkpoint = async()=>{} },
) {
  await checkpoint();
  const candidate = verifyCandidate(candidateDir),
    binding = verifyBinding(bindingPath),
    base = safeUrl(url);
  const manifestBytes = await fetchExact(
    base,
    "manifest.json",
    candidate.manifestBytes.length,
    fetchImpl,
  );
  if (!manifestBytes.equals(candidate.manifestBytes)) {
    throw new Error("served manifest bytes do not match the exact candidate");
  }
  const notFound = await fetchMissingRoute(base, candidate, fetchImpl);
  const representative = previewReceivingArtifacts(candidate), artifacts = [];
  for (const artifact of representative) {
    const bytes = await fetchExact(
      base,
      artifact.file,
      artifact.bytes,
      fetchImpl,
    );
    if (sha256Hex(bytes) !== artifact.sha256) {
      throw new Error(
        `served sealed artifact does not match: ${artifact.file}`,
      );
    }
    artifacts.push({
      file: artifact.file,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
    });
  }
  const redirects = await observeRedirects(base, candidate, fetchImpl);
  await checkpoint();return receiptPath(receiptOut, {
    kind: "koios.news.cloudflare-preview-receipt/v1",
    candidateManifestSha256: candidate.manifestDigest,
    binding: TARGET,
    bindingSha256: binding.digest,
    probe: {
      accepted: true,
      url: base.toString(),
      candidateManifestSha256: candidate.manifestDigest,
      bindingSha256: binding.digest,
      manifestSha256: sha256Hex(manifestBytes),
      notFound,
      artifacts,
      redirects,
    },
  });
}
