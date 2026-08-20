"use client";

import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Upload, AlertCircle } from "lucide-react";
import { DashboardWalletEmpty } from "@/components/dashboard/dashboard-wallet-empty";
import { useWallet } from "@/contexts/WalletContext";
import { toast } from "sonner";
import type { PaymentInstruction } from "@/lib/stellar/types";
import {
  buildBatchRevokeTransaction,
  buildClaimTransaction,
  buildDepositTransaction,
  buildRevokeTransaction,
} from "@/lib/stellar/vesting";
import { acquireGuard, ReentrancyError } from "@/lib/stellar/reentrancy-guard";
import { resolveVestingContractId } from "@/lib/stellar/vesting-config";
import { parsePaymentFile } from "@/lib/stellar/parser";
import { Networks, TransactionBuilder } from "stellar-sdk";
import { t } from "@/lib/i18n";

interface VestingSchedule {
  id: string;
  /** On-chain schedule index for this recipient (per-recipient, not batch row). */
  index: number;
  recipient: string;
  amount: string;
  asset: string;
  startTime: number;
  endTime: number;
  vestingStep: number;
  claimableAmount: string;
  claimedAmount: string;
  status: "pending" | "vesting" | "claimable" | "completed";
  transactionHash?: string;
}

interface VestingBatch {
  id: string;
  name: string;
  createdAt: string;
  totalRecipients: number;
  totalAmount: string;
  status: "draft" | "submitted" | "completed";
  schedules: VestingSchedule[];
}

export default function VestingPage() {
  const { publicKey, expectedNetwork, signTx } = useWallet();
  const [activeTab, setActiveTab] = useState<"deposit" | "manage" | "claim">("deposit");
  const [batches, setBatches] = useState<VestingBatch[]>([]);
  const [currentBatch, setCurrentBatch] = useState<VestingBatch | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [vestingConfig, setVestingConfig] = useState({
    startDate: "",
    endDate: "",
    vestingStep: "86400", // 1 day in seconds
  });

  const handleFileSelect = async (file: File) => {
    if (!publicKey) {
      toast.error(t("common.walletNotConnected"));
      return;
    }

    try {
      setIsUploading(true);
      const content = await file.text();
      let parsedFile;
      
      try {
        parsedFile = parsePaymentFile(content, file.name.toLowerCase().endsWith('.json') ? 'json' : 'csv');
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t("errors.parseFailed"));
        setIsUploading(false);
        return;
      }

      if (parsedFile.invalidCount > 0) {
        toast.error(`Validation failed for ${parsedFile.invalidCount} rows. Please fix errors and try again.`);
        setIsUploading(false);
        return;
      }

      const schedules: VestingSchedule[] = [];
      const recipients = new Set<string>();
      // Per-recipient on-chain indices (push_vesting appends; unique recipients
      // each start at 0 within a fresh batch).
      const recipientNextIndex = new Map<string, number>();
      let totalAmount = "0";

      for (let i = 0; i < parsedFile.validPayments.length; i++) {
        const payment = parsedFile.validPayments[i];
        recipients.add(payment.address);
        const index = recipientNextIndex.get(payment.address) ?? 0;
        recipientNextIndex.set(payment.address, index + 1);
        schedules.push({
          id: `${i}`,
          index,
          recipient: payment.address,
          amount: payment.amount,
          asset: payment.asset || "XLM",
          startTime: vestingConfig.startDate
            ? Math.floor(new Date(vestingConfig.startDate).getTime() / 1000)
            : Math.floor(Date.now() / 1000),
          endTime: vestingConfig.endDate
            ? Math.floor(new Date(vestingConfig.endDate).getTime() / 1000)
            : Math.floor(Date.now() / 1000) + 7776000,
          vestingStep: parseInt(vestingConfig.vestingStep),
          claimableAmount: "0",
          claimedAmount: "0",
          status: "pending",
        });
        totalAmount = (parseFloat(totalAmount) + parseFloat(payment.amount)).toString();
      }

      const batch: VestingBatch = {
        id: `batch-${Date.now()}`,
        name: file.name,
        createdAt: new Date().toISOString(),
        totalRecipients: recipients.size,
        totalAmount,
        status: "draft",
        schedules,
      };

      setCurrentBatch(batch);
      toast.success(t("vesting.parsedSchedules", { count: schedules.length }));
    } catch (err) {
      toast.error(t("errors.parseFailed"));
      console.error(err);
    } finally {
      setIsUploading(false);
    }
  };

  /**
   * Sign an assembled Soroban XDR with the connected wallet and submit it
   * via RPC, polling briefly for confirmation. Returns the transaction hash.
   */
  const signAndSubmitXdr = async (
    unsignedXdr: string,
    network: "testnet" | "mainnet",
  ): Promise<{ hash: string; confirmed: boolean }> => {
    const signedXdr = await signTx(unsignedXdr, network);

    const { rpc: SorobanRpc } = await import("stellar-sdk");
    const rpcUrl =
      network === "testnet"
        ? "https://soroban-testnet.stellar.org"
        : "https://soroban-mainnet.stellar.org";
    const server = new SorobanRpc.Server(rpcUrl, { allowHttp: false });

    const networkPassphrase =
      network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
    const tx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
    const sendResult = await server.sendTransaction(tx);

    if (sendResult.status !== "PENDING" && sendResult.status !== "DUPLICATE") {
      throw new Error(`Transaction submission failed: ${sendResult.status}`);
    }

    const hash = sendResult.hash;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const getResult = await server.getTransaction(hash);
      if (getResult.status === "SUCCESS") {
        return { hash, confirmed: true };
      }
      if (getResult.status === "FAILED") {
        throw new Error("Transaction failed on-chain");
      }
    }

    return { hash, confirmed: false };
  };

  const handleSubmitBatch = async () => {
    if (!currentBatch || !publicKey) {
      toast.error(t("common.walletNotConnected"));
      return;
    }

    let release: (() => void) | null = null;
    try {
      release = await acquireGuard(publicKey, "deposit");
    } catch (err) {
      if (err instanceof ReentrancyError) {
        toast.error(err.message);
        return;
      }
      throw err;
    }

    try {
      setIsProcessing(true);

      const network = expectedNetwork === "mainnet" ? "mainnet" : "testnet";

      // Map schedules to PaymentInstruction[]
      const payments: PaymentInstruction[] = currentBatch.schedules.map((s) => ({
        address: s.recipient,
        amount: s.amount,
        asset: s.asset,
      }));

      const startTime = vestingConfig.startDate
        ? Math.floor(new Date(vestingConfig.startDate).getTime() / 1000)
        : Math.floor(Date.now() / 1000);

      const endTime = vestingConfig.endDate
        ? Math.floor(new Date(vestingConfig.endDate).getTime() / 1000)
        : Math.floor(Date.now() / 1000) + 7776000;

      const vestingStep = parseInt(vestingConfig.vestingStep);
      const cliffTime = startTime;

      let contractId: string;
      try {
        contractId = resolveVestingContractId(network);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Invalid vesting contract configuration";
        toast.error(msg);
        return;
      }

      const unsignedXdr = await buildDepositTransaction(
        contractId,
        payments,
        startTime,
        endTime,
        cliffTime,
        vestingStep,
        network,
        publicKey,
      );

      const { hash: txHash, confirmed } = await signAndSubmitXdr(unsignedXdr, network);

      if (!confirmed) {
        toast.warning("Transaction submitted but not yet confirmed. Check history for updates.");
      }

      const submittedBatch: VestingBatch = {
        ...currentBatch,
        status: "submitted",
        schedules: currentBatch.schedules.map((s) => ({
          ...s,
          status: "vesting" as const,
          transactionHash: txHash,
        })),
      };
      setBatches([...batches, submittedBatch]);
      setCurrentBatch(null);
      toast.success(t("vesting.submittedSuccess"));
      setActiveTab("manage");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Submission failed";
      toast.error(msg);
      console.error(err);
    } finally {
      setIsProcessing(false);
      if (release) {
        release();
      }
    }
  };

  const handleClaim = async (schedule: VestingSchedule) => {
    if (!publicKey) {
      toast.error(t("common.walletNotConnected"));
      return;
    }

    let release: (() => void) | null = null;
    try {
      release = await acquireGuard(publicKey, "claim");
    } catch (err) {
      if (err instanceof ReentrancyError) {
        toast.error(err.message);
        return;
      }
      throw err;
    }

    try {
      setIsProcessing(true);
      const network = expectedNetwork === "mainnet" ? "mainnet" : "testnet";
      const contractId = resolveVestingContractId(network);

      // claim(recipient, index, amount) — index is required by the contract ABI.
      const unsignedXdr = await buildClaimTransaction(
        contractId,
        schedule.recipient,
        schedule.index,
        schedule.claimableAmount,
        network,
        publicKey,
        schedule.asset,
      );

      const { hash: txHash, confirmed } = await signAndSubmitXdr(unsignedXdr, network);

      setBatches((prev) =>
        prev.map((batch) => ({
          ...batch,
          schedules: batch.schedules.map((s) =>
            s.id === schedule.id && s.recipient === schedule.recipient
              ? {
                  ...s,
                  claimedAmount: (
                    parseFloat(s.claimedAmount) + parseFloat(s.claimableAmount)
                  ).toString(),
                  claimableAmount: "0",
                  status: "completed" as const,
                  transactionHash: txHash,
                }
              : s,
          ),
        })),
      );

      if (!confirmed) {
        toast.warning("Claim submitted but not yet confirmed. Check history for updates.");
      } else {
        toast.success("Claim submitted successfully");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Claim failed";
      toast.error(msg);
      console.error(err);
    } finally {
      setIsProcessing(false);
      if (release) {
        release();
      }
    }
  };

  const handleRevoke = async (schedules: VestingSchedule[], batchId: string) => {
    if (!publicKey) {
      toast.error(t("common.walletNotConnected"));
      return;
    }

    if (schedules.length === 0) {
      toast.error("No schedules to revoke");
      return;
    }

    if (!confirm("Are you sure you want to revoke these vesting schedules?")) {
      return;
    }

    let release: (() => void) | null = null;
    try {
      release = await acquireGuard(publicKey, "revoke");
    } catch (err) {
      if (err instanceof ReentrancyError) {
        toast.error(err.message);
        return;
      }
      throw err;
    }

    try {
      setIsProcessing(true);
      const network = expectedNetwork === "mainnet" ? "mainnet" : "testnet";
      const contractId = resolveVestingContractId(network);

      // revoke(caller, recipient, index) or batch_revoke(caller, requests)
      // — both require exact schedule indices, not just recipient addresses.
      const unsignedXdr =
        schedules.length === 1
          ? await buildRevokeTransaction(
              contractId,
              schedules[0].recipient,
              schedules[0].index,
              network,
              publicKey,
            )
          : await buildBatchRevokeTransaction(
              contractId,
              schedules.map((s) => ({
                recipient: s.recipient,
                index: s.index,
              })),
              network,
              publicKey,
            );

      const { confirmed } = await signAndSubmitXdr(unsignedXdr, network);

      setBatches((prev) => prev.filter((b) => b.id !== batchId));

      if (!confirmed) {
        toast.warning("Revoke submitted but not yet confirmed. Check history for updates.");
      } else {
        toast.success("Vesting schedules revoked successfully");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Revoke failed";
      toast.error(msg);
      console.error(err);
    } finally {
      setIsProcessing(false);
      if (release) {
        release();
      }
    }
  };

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight text-white">
          {t("vesting.title")}
        </h1>
        <p className="text-gray-400">
          {t("vesting.description")}
        </p>
      </div>

      {!publicKey ? (
        <DashboardWalletEmpty />
      ) : (
        <>
      <div className="flex gap-2 border-b border-[#1F2937]">
        <button
          onClick={() => setActiveTab("deposit")}
          className={`px-4 py-2 font-medium transition-colors ${
            activeTab === "deposit"
              ? "border-b-2 border-emerald-500 text-emerald-500"
              : "text-gray-400 hover:text-white"
          }`}
        >
          {t("vesting.deposit")}
        </button>
        <button
          onClick={() => setActiveTab("manage")}
          className={`px-4 py-2 font-medium transition-colors ${
            activeTab === "manage"
              ? "border-b-2 border-emerald-500 text-emerald-500"
              : "text-gray-400 hover:text-white"
          }`}
        >
          {t("vesting.manage")}
        </button>
        <button
          onClick={() => setActiveTab("claim")}
          className={`px-4 py-2 font-medium transition-colors ${
            activeTab === "claim"
              ? "border-b-2 border-emerald-500 text-emerald-500"
              : "text-gray-400 hover:text-white"
          }`}
        >
          {t("vesting.claims")}
        </button>
      </div>

      {/* Deposit Tab */}
      {activeTab === "deposit" && (
        <div className="space-y-6">
          <Card className="bg-slate-900/50 border-slate-800">
            <CardHeader>
              <CardTitle className="text-lg text-white">{t("vesting.uploadRecipients")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="rounded-lg border-2 border-dashed border-slate-700 p-8 text-center">
                <Upload className="mx-auto h-8 w-8 text-slate-500 mb-2" />
                <p className="text-sm text-slate-400 mb-4">
                  {t("vesting.uploadCsv")}
                </p>
                <input
                  type="file"
                  ref={fileInputRef}
                  className="hidden"
                  accept=".csv"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleFileSelect(file);
                  }}
                />
                <Button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isUploading}
                  className="bg-emerald-500 hover:bg-emerald-600"
                >
                  {isUploading ? t("vesting.uploading") : t("vesting.chooseFile")}
                </Button>
              </div>

              {currentBatch && (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="bg-slate-800/50 rounded-lg p-4">
                      <p className="text-sm text-slate-400">{t("vesting.totalRecipients")}</p>
                      <p className="text-2xl font-bold text-white">
                        {currentBatch.totalRecipients}
                      </p>
                    </div>
                    <div className="bg-slate-800/50 rounded-lg p-4">
                      <p className="text-sm text-slate-400">{t("vesting.totalAmount")}</p>
                      <p className="text-2xl font-bold text-white">
                        {parseFloat(currentBatch.totalAmount).toFixed(2)} {currentBatch.schedules[0]?.asset}
                      </p>
                    </div>
                    <div className="bg-slate-800/50 rounded-lg p-4">
                      <p className="text-sm text-slate-400">Network</p>
                      <p className="text-2xl font-bold text-white capitalize">
                        {expectedNetwork}
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-slate-400">{t("vesting.startDate")}</label>
                      <Input
                        type="datetime-local"
                        value={vestingConfig.startDate}
                        onChange={(e) =>
                          setVestingConfig({ ...vestingConfig, startDate: e.target.value })
                        }
                        className="bg-slate-950 border-slate-800 text-white"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-slate-400">{t("vesting.endDate")}</label>
                      <Input
                        type="datetime-local"
                        value={vestingConfig.endDate}
                        onChange={(e) =>
                          setVestingConfig({ ...vestingConfig, endDate: e.target.value })
                        }
                        className="bg-slate-950 border-slate-800 text-white"
                      />
                    </div>
                  </div>

                  <div className="flex gap-3">
                    <Button
                      onClick={handleSubmitBatch}
                      disabled={isProcessing}
                      className="flex-1 bg-emerald-500 hover:bg-emerald-600"
                    >
                      {isProcessing ? t("vesting.submitting") : t("vesting.submitBatch")}
                    </Button>
                    <Button
                      onClick={() => setCurrentBatch(null)}
                      variant="outline"
                      className="border-slate-800"
                    >
                      {t("common.cancel")}
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Manage Tab */}
      {activeTab === "manage" && (
        <div className="space-y-6">
          {batches.length === 0 ? (
            <Card className="bg-slate-900/50 border-slate-800">
              <CardContent className="p-8 text-center">
                <AlertCircle className="mx-auto h-8 w-8 text-slate-500 mb-2" />
                <p className="text-slate-400">
                  {t("vesting.noBatches")}
                </p>
              </CardContent>
            </Card>
          ) : (
            batches.map((batch) => (
              <Card key={batch.id} className="bg-slate-900/50 border-slate-800 overflow-hidden">
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="text-lg text-white">{batch.name}</CardTitle>
                      <p className="text-sm text-slate-400 mt-1">
                        {batch.totalRecipients} recipients - {batch.totalAmount} total
                      </p>
                    </div>
                    <div className={`px-3 py-1 rounded-full text-sm font-medium ${
                      batch.status === "completed"
                        ? "bg-emerald-500/20 text-emerald-400"
                        : "bg-blue-500/20 text-blue-400"
                    }`}>
                      {batch.status}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="border-b border-slate-700">
                        <tr>
                          <th className="text-left p-2 text-slate-400 font-medium">Recipient</th>
                          <th className="text-right p-2 text-slate-400 font-medium">Amount</th>
                          <th className="text-right p-2 text-slate-400 font-medium">Claimable</th>
                          <th className="text-right p-2 text-slate-400 font-medium">Status</th>
                    <th className="text-right p-2 text-slate-400 font-medium">Tx Hash</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-700/50">
                        {batch.schedules.slice(0, 5).map((schedule) => (
                          <tr key={schedule.id} className="hover:bg-white/5">
                            <td className="p-2 text-slate-300 font-mono text-xs">
                              {schedule.recipient.slice(0, 8)}...
                            </td>
                            <td className="p-2 text-right text-white">
                              {parseFloat(schedule.amount).toFixed(2)} {schedule.asset}
                            </td>
                            <td className="p-2 text-right text-emerald-400">
                              {parseFloat(schedule.claimableAmount).toFixed(2)}
                            </td>
                            <td className="p-2 text-right">
                              <span className="text-xs px-2 py-1 rounded-full bg-blue-500/20 text-blue-400">
                                {schedule.status}
                              </span>
                            </td>
                            <td className="p-2 text-right">
                              {schedule.transactionHash ? (
                                <a
                                  href={`https://stellar.expert/explorer/${expectedNetwork === "mainnet" ? "public" : "testnet"}/tx/${schedule.transactionHash}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-[10px] text-emerald-400 hover:underline font-mono"
                                >
                                  {schedule.transactionHash.slice(0, 8)}...
                                </a>
                              ) : (
                                <span className="text-[10px] text-slate-600">—</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      onClick={() => handleRevoke(batch.schedules, batch.id)}
                      variant="destructive"
                      className="w-full"
                      disabled={isProcessing}
                    >
                      {isProcessing ? t("vesting.processing") : t("vesting.revokeAll")}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>
      )}

      {/* Claims Tab */}
      {activeTab === "claim" && (
        <div className="space-y-6">
          <Card className="bg-slate-900/50 border-slate-800">
            <CardHeader>
              <CardTitle className="text-lg text-white">{t("vesting.availableClaims")}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-slate-400 mb-4">
                {t("vesting.viewAndClaim")}
              </p>
              {batches
                .flatMap((batch) =>
                  batch.schedules
                    .filter((s) => s.status === "claimable")
                    .map((s) => (
                      <div
                        key={s.id}
                        className="flex items-center justify-between p-4 bg-slate-800/50 rounded-lg mb-3"
                      >
                        <div>
                          <p className="text-white font-medium">
                            {parseFloat(s.claimableAmount).toFixed(2)} {s.asset}
                          </p>
                          <p className="text-sm text-slate-400 font-mono">
                            {s.recipient.slice(0, 16)}...
                          </p>
                        </div>
                        <Button
                          onClick={() => handleClaim(s)}
                          disabled={isProcessing}
                          className="bg-emerald-500 hover:bg-emerald-600"
                        >
                          {isProcessing ? t("vesting.processing") : t("vesting.claim")}
                        </Button>
                      </div>
                    ))
                )
                .slice(0, 10)}
              {batches.flatMap((b) => b.schedules).filter((s) => s.status === "claimable")
                .length === 0 && (
                <p className="text-slate-400 text-center py-8">
                  {t("vesting.noClaimableTokens")}
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      )}
        </>
      )}
    </div>
  );
}
