import Decimal from "decimal.js";
import bs58 from "bs58";
import { FetchRequest, JsonRpcProvider, Wallet } from "ethers";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import type { AssetConfig, Config } from "../config.js";
import { solanaRpcFetch } from "../solana-rpc-logging.js";
import { okxPrivateGet, type Credentials } from "../market/okx.js";
import { SOLANA_CHAIN, XLAYER_CHAIN } from "../market/valuation.js";

type CexBalance = { ccy: string; availBal: string };
const fail = (message: string): never => { throw new Error(message); };
export async function okxAvailable(credentials: Credentials, currency: string): Promise<Decimal> {
  const rows = await okxPrivateGet<Array<{ details?: CexBalance[] }>>(`/api/v5/account/balance?ccy=${encodeURIComponent(currency)}`, credentials);
  const row = rows[0]?.details?.find((item) => item.ccy === currency);
  const amount = new Decimal(row?.availBal ?? "0");
  if (!amount.isFinite() || amount.lt(0)) fail(`OKX available ${currency} balance is unavailable`);
  return amount;
}
export function signer(chainIndex: string, xlayerKey: string, solanaKey: string): { address: string; evm?: Wallet; solana?: Keypair } | null {
  try {
    if (chainIndex === XLAYER_CHAIN && xlayerKey) {
      const evm = new Wallet(xlayerKey);
      return { address: evm.address, evm };
    }
    if (chainIndex === SOLANA_CHAIN && solanaKey) {
      const secret = solanaKey.trim();
      const bytes = secret.startsWith("[")
        ? Uint8Array.from(JSON.parse(secret) as number[])
        : bs58.decode(secret);
      const solana = bytes.length === 32 ? Keypair.fromSeed(bytes) : Keypair.fromSecretKey(bytes);
      return { address: solana.publicKey.toBase58(), solana };
    }
  } catch {
    fail(`Invalid ${chainIndex === XLAYER_CHAIN ? "X Layer" : "Solana"} runtime private key`);
  }
  return null;
}

export function validateTradeSigners(assets: AssetConfig[], signers: Config["signers"]): void {
  for (const asset of assets) {
    if (signer(asset.chainIndex, signers.xlayerPrivateKey, signers.solanaPrivateKey)) continue;
    const secretName = asset.chainIndex === XLAYER_CHAIN ? "XLAYER_PRIVATE_KEY" : "SOLANA_PRIVATE_KEY";
    fail(`Trading is enabled but ${secretName} is required for ${asset.network} route (${asset.instId})`);
  }
}

let sharedEvmProvider: JsonRpcProvider | undefined;
export function evmProvider(): JsonRpcProvider {
  if (!sharedEvmProvider) {
    const request = new FetchRequest(process.env.XLAYER_RPC_URL || "https://rpc.xlayer.tech");
    request.timeout = 10_000;
    sharedEvmProvider = new JsonRpcProvider(request, 196, { staticNetwork: true });
  }
  return sharedEvmProvider;
}

export async function readChainBalances(asset: AssetConfig, owner: string, signers: Config["signers"]): Promise<{ asset: bigint; quote: bigint; native: bigint }> {
  if (asset.chainIndex === XLAYER_CHAIN) {
    const provider = evmProvider();
    const [token, quote, native] = await Promise.all([
      readEvmTokenBalance(provider, asset.tokenAddress, owner),
      readEvmTokenBalance(provider, asset.quoteTokenAddress, owner),
      provider.getBalance(owner),
    ]);
    return { asset: token, quote, native };
  }
  const connection = new Connection(signers.solanaRpcUrl, { commitment: "confirmed", fetch: solanaRpcFetch });
  const ownerKey = new PublicKey(owner);
  const tokenKey = new PublicKey(asset.tokenAddress);
  const quoteKey = new PublicKey(asset.quoteTokenAddress);
  const [token, quote, native] = await Promise.all([
    readSolTokenBalance(connection, ownerKey, tokenKey, asset.tokenDecimals),
    readSolTokenBalance(connection, ownerKey, quoteKey, asset.quoteTokenDecimals),
    connection.getBalance(ownerKey, "confirmed"),
  ]);
  return { asset: token, quote, native: BigInt(native) };
}

export async function inspectRouteBalances(
  asset: AssetConfig, credentials: Credentials, signers: Config["signers"],
): Promise<{ walletAddress: string; cexUsdt: string; cexAsset: string; chainAssetRaw: string; chainQuoteRaw: string; chainNativeRaw: string }> {
  const wallet = signer(asset.chainIndex, signers.xlayerPrivateKey, signers.solanaPrivateKey);
  if (!wallet) throw new Error(`Wallet signer is unavailable for ${asset.network}`);
  const [cexUsdt, cexAsset, chain] = await Promise.all([
    okxAvailable(credentials, "USDT"),
    okxAvailable(credentials, asset.okxCurrency),
    readChainBalances(asset, wallet.address, signers),
  ]);
  return {
    walletAddress: wallet.address,
    cexUsdt: cexUsdt.toString(),
    cexAsset: cexAsset.toString(),
    chainAssetRaw: chain.asset.toString(),
    chainQuoteRaw: chain.quote.toString(),
    chainNativeRaw: chain.native.toString(),
  };
}

async function readEvmTokenBalance(provider: JsonRpcProvider, token: string, owner: string): Promise<bigint> {
  const data = `0x70a08231${owner.slice(2).toLowerCase().padStart(64, "0")}`;
  const result = await provider.call({ to: token, data });
  if (!/^0x[\da-f]{64}$/i.test(result)) fail("X Layer token balance response is invalid");
  return BigInt(result);
}
async function readSolTokenBalance(connection: Connection, owner: PublicKey, mint: PublicKey, expectedDecimals: number): Promise<bigint> {
  const result = await connection.getParsedTokenAccountsByOwner(owner, { mint }, "confirmed");
  let total = 0n;
  for (const account of result.value) {
    const parsed = account.account.data as { parsed?: { info?: { tokenAmount?: { amount?: string; decimals?: number } } } };
    const tokenAmount = parsed.parsed?.info?.tokenAmount;
    const raw = tokenAmount?.amount;
    if (!tokenAmount || raw === undefined || tokenAmount.decimals !== expectedDecimals || !/^\d+$/.test(raw)) throw new Error("Solana token account metadata does not match pinned decimals");
    total += BigInt(raw);
  }
  return total;
}

export async function readSwapDeltas(asset: AssetConfig, txHash: string, owner: string, solanaRpcUrl: string): Promise<{ assetDelta: bigint; quoteDelta: bigint }> {
  if (asset.chainIndex === XLAYER_CHAIN) {
    const receipt = await evmProvider().getTransactionReceipt(txHash);
    if (!receipt || receipt.status !== 1) throw new Error("Confirmed X Layer swap receipt is unavailable");
    const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    const ownerTopic = `0x${owner.slice(2).toLowerCase().padStart(64, "0")}`;
    let assetDelta = 0n;
    let quoteDelta = 0n;
    for (const log of receipt.logs) {
      if (log.topics[0]?.toLowerCase() !== transferTopic || !log.topics[1] || !log.topics[2]) continue;
      const from = log.topics[1].toLowerCase();
      const to = log.topics[2].toLowerCase();
      const amount = BigInt(log.data);
      if (log.address.toLowerCase() === asset.tokenAddress.toLowerCase()) {
        if (from === ownerTopic) assetDelta -= amount;
        if (to === ownerTopic) assetDelta += amount;
      }
      if (log.address.toLowerCase() === asset.quoteTokenAddress.toLowerCase()) {
        if (from === ownerTopic) quoteDelta -= amount;
        if (to === ownerTopic) quoteDelta += amount;
      }
    }
    return { assetDelta, quoteDelta };
  }
  const connection = new Connection(solanaRpcUrl, { commitment: "confirmed", fetch: solanaRpcFetch });
  const transaction = await connection.getTransaction(txHash, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const meta = transaction?.meta;
  if (!meta || meta.err) throw new Error("Confirmed Solana swap metadata is unavailable");
  const sumMint = (rows: typeof meta.preTokenBalances, mint: string) => (rows ?? [])
    .filter((row) => row.mint === mint && row.owner === owner)
    .reduce((sum, row) => sum + BigInt(row.uiTokenAmount.amount), 0n);
  const tokenDelta = sumMint(meta.postTokenBalances, asset.tokenAddress) - sumMint(meta.preTokenBalances, asset.tokenAddress);
  const stableDelta = sumMint(meta.postTokenBalances, asset.quoteTokenAddress) - sumMint(meta.preTokenBalances, asset.quoteTokenAddress);
  return { assetDelta: tokenDelta, quoteDelta: stableDelta };
}

export async function readEvmAllowance(provider: JsonRpcProvider, token: string, owner: string, spender: string): Promise<bigint> {
  const data = `0xdd62ed3e${owner.slice(2).toLowerCase().padStart(64, "0")}${spender.slice(2).toLowerCase().padStart(64, "0")}`;
  const result = await provider.call({ to: token, data });
  if (!/^0x[\da-f]{64}$/i.test(result)) fail("X Layer token allowance response is invalid");
  return BigInt(result);
}
