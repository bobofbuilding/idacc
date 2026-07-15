import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { Signature, Transaction, getAddress } from 'ethers';

export interface AgentEip1559Transaction {
  chainId: number;
  nonce: number;
  to: string;
  data: string;
  valueWei?: string;
  gasLimit: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
}

export function ethereumAddressForPrivateKey(privateKey: Uint8Array): string {
  const publicKey = secp256k1.getPublicKey(privateKey, false).slice(1);
  const digest = keccak_256(publicKey);
  return `0x${Buffer.from(digest.slice(-20)).toString('hex')}`;
}

export function createAgentPrivateKey(): Uint8Array {
  return secp256k1.utils.randomSecretKey();
}

/** Signs an already-hashed 32-byte EVM digest and returns r || s || v. */
export function signEvmDigest(privateKey: Uint8Array, digest: Uint8Array): string {
  if (digest.length !== 32) throw new Error('EVM signing requires an exact 32-byte digest.');
  const signature = secp256k1.sign(digest, privateKey, { prehash: false, lowS: true, extraEntropy: true });
  const recovery = signature.recovery;
  if (recovery !== 0 && recovery !== 1) throw new Error('Unsupported secp256k1 recovery id.');
  return `0x${signature.toCompactHex()}${(27 + recovery).toString(16).padStart(2, '0')}`;
}

export function signEip1559Transaction(privateKey: Uint8Array, input: AgentEip1559Transaction): { rawTransaction: string; hash: string } {
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) throw new Error('Transaction chain id is invalid.');
  if (!Number.isSafeInteger(input.nonce) || input.nonce < 0) throw new Error('Transaction nonce is invalid.');
  if (!/^0x(?:[0-9a-f]{2})*$/i.test(input.data)) throw new Error('Transaction calldata must be even-length 0x hex.');
  const numericFields = [input.valueWei ?? '0', input.gasLimit, input.maxFeePerGas, input.maxPriorityFeePerGas];
  if (numericFields.some((value) => !/^(0|[1-9][0-9]*)$/.test(value))) throw new Error('Transaction fee, gas, and value fields must be non-negative integers.');

  const transaction = Transaction.from({
    type: 2,
    chainId: input.chainId,
    nonce: input.nonce,
    to: getAddress(input.to),
    data: input.data,
    value: BigInt(input.valueWei ?? '0'),
    gasLimit: BigInt(input.gasLimit),
    maxFeePerGas: BigInt(input.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(input.maxPriorityFeePerGas),
  });
  transaction.signature = Signature.from(signEvmDigest(privateKey, Buffer.from(transaction.unsignedHash.slice(2), 'hex')));
  return { rawTransaction: transaction.serialized, hash: transaction.hash! };
}
