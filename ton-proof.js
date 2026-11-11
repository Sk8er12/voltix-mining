import { sha256 } from "@ton/crypto";
import {
  Address,
  Cell,
  contractAddress,
  domainSignVerify,
  loadStateInit
} from "@ton/ton";
import { Buffer } from "buffer";
import { tryParsePublicKey } from "./wrappers/wallets-data.js";

const PROOF_PREFIX = Buffer.from("ton-proof-item-v2/", "utf8");
const CONNECT_PREFIX = Buffer.from("ton-connect", "utf8");
const EXPECTED_DOMAIN = "voltix-mining.pages.dev";
const MAX_PROOF_AGE_SECONDS = 10 * 60;

function signatureDomain(network) {
  // TON mainnet and testnet both use the empty signature domain.
  if (network === "-239" || network === "-3") return { type: "empty" };
  return { type: "l2", globalId: Number(network) };
}

export async function verifyTonProof({ address, network, public_key, proof, expectedPayload }) {
  try {
    if (typeof address !== "string" || String(network) !== "-3") return false;
    if (!proof || typeof proof !== "object") return false;
    if (typeof proof.state_init !== "string" || typeof proof.signature !== "string") return false;
    if (typeof proof.payload !== "string" || proof.payload !== expectedPayload) return false;
    if (Buffer.byteLength(proof.payload, "utf8") > 128) return false;

    const timestamp = Number(proof.timestamp);
    if (!Number.isSafeInteger(timestamp) || timestamp <= 0) return false;
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > MAX_PROOF_AGE_SECONDS) return false;

    if (!proof.domain || proof.domain.value !== EXPECTED_DOMAIN) return false;
    const domainBytes = Buffer.from(proof.domain.value, "utf8");
    if (domainBytes.length > 128 || proof.domain.lengthBytes !== domainBytes.length) return false;

    const wantedAddress = Address.parse(address);
    const stateInit = loadStateInit(Cell.fromBase64(proof.state_init).beginParse());
    const derivedAddress = contractAddress(wantedAddress.workChain, stateInit);
    if (!derivedAddress.equals(wantedAddress)) return false;

    const publicKey = tryParsePublicKey(stateInit);
    if (!publicKey || publicKey.length !== 32) return false;

    // public_key is optional in the SDK reply; when present it must match StateInit.
    if (public_key !== undefined && public_key !== null) {
      if (typeof public_key !== "string" || !/^[0-9a-fA-F]{64}$/.test(public_key)) return false;
      if (!publicKey.equals(Buffer.from(public_key, "hex"))) return false;
    }

    const signature = Buffer.from(proof.signature, "base64");
    if (signature.length !== 64) return false;

    const workchain = Buffer.alloc(4);
    workchain.writeInt32BE(wantedAddress.workChain, 0);
    const domainLength = Buffer.alloc(4);
    domainLength.writeUInt32LE(domainBytes.length, 0);
    const timestampBytes = Buffer.alloc(8);
    timestampBytes.writeBigUInt64LE(BigInt(timestamp), 0);

    const message = Buffer.concat([
      PROOF_PREFIX,
      workchain,
      wantedAddress.hash,
      domainLength,
      domainBytes,
      timestampBytes,
      Buffer.from(proof.payload, "utf8")
    ]);

    const messageHash = Buffer.from(await sha256(message));
    const digest = Buffer.from(await sha256(Buffer.concat([
      Buffer.from([0xff, 0xff]),
      CONNECT_PREFIX,
      messageHash
    ])));

    return domainSignVerify({
      data: digest,
      signature,
      publicKey,
      domain: signatureDomain(String(network))
    });
  } catch {
    return false;
  }
}
