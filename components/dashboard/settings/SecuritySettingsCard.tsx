"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { AlertCircle, CheckCircle2, ShieldCheck, Wallet } from "lucide-react";

const securityRecommendations = [
  "Approve transactions only after reviewing the wallet prompt, destination addresses, amounts, and network.",
  "Keep your Freighter password and recovery phrase private. BatchPay never asks for either one.",
  "Use a hardware wallet such as Ledger for higher-value accounts when possible.",
  "Disconnect BatchPay or revoke site permissions from your wallet if you stop using this device.",
];

const unsupportedControls = [
  "Password changes",
  "Two-factor authentication toggles",
  "Server-managed active sessions",
];

export function SecuritySettingsCard() {
  return (
    <Card className="bg-slate-900/50 border-slate-800">
      <CardHeader>
        <div className="flex items-start gap-4">
          <div className="p-3 bg-emerald-500/10 rounded-lg">
            <ShieldCheck className="w-6 h-6 text-emerald-500" />
          </div>
          <div className="flex-1">
            <CardTitle className="text-2xl text-white">
              Wallet Security
            </CardTitle>
            <CardDescription className="text-slate-400">
              Stellar BatchPay uses your connected Stellar wallet as your identity
            </CardDescription>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-4">
          <div className="flex items-start gap-3">
            <Wallet className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
            <div className="space-y-1">
              <div className="font-medium text-white">
                No BatchPay password or 2FA account
              </div>
              <p className="text-sm leading-6 text-slate-300">
                BatchPay does not store login passwords, recovery phrases, or
                two-factor settings. Authentication and transaction approval
                happen in your wallet, such as Freighter or Ledger.
              </p>
            </div>
          </div>
        </div>

        <div>
          <h3 className="text-sm font-semibold text-slate-200">
            Protect your wallet
          </h3>
          <div className="mt-3 grid gap-3">
            {securityRecommendations.map((recommendation) => (
              <div key={recommendation} className="flex items-start gap-3">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                <p className="text-sm leading-6 text-slate-400">
                  {recommendation}
                </p>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
            <div className="space-y-3">
              <div>
                <div className="font-medium text-white">
                  Account-security controls are not available
                </div>
                <p className="mt-1 text-sm leading-6 text-slate-400">
                  These controls are intentionally absent until BatchPay has a
                  real account backend that can enforce them.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {unsupportedControls.map((control) => (
                  <span
                    key={control}
                    className="rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1 text-xs font-medium text-slate-300"
                  >
                    {control}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
