"use client";

import { Zap, DollarSign, Globe } from "lucide-react";

/* ─── Reusable sub-components ─────────────────────────────────────────────── */

interface CostRowProps {
  label: string;
  value: string;
  isTotal?: boolean;
}

function CostRow({ label, value, isTotal = false }: CostRowProps) {
  if (isTotal) {
    return (
      <div className="flex items-center justify-between pt-4 border-t border-slate-700/60">
        <span className="text-white font-bold text-base">{label}</span>
        <span className="text-emerald-400 font-bold text-base">{value}</span>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-slate-400 text-sm">{label}</span>
      <span className="text-slate-300 text-sm font-medium">{value}</span>
    </div>
  );
}

interface BenefitItemProps {
  icon: React.ReactNode;
  label: string;
}

function BenefitItem({ icon, label }: BenefitItemProps) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-emerald-400 flex-shrink-0">{icon}</span>
      <span className="text-slate-300 text-sm">{label}</span>
    </div>
  );
}

/* ─── Main Section ─────────────────────────────────────────────────────────── */

export function CostExampleSection() {
  const costRows: CostRowProps[] = [
    { label: "Network fees (100 × 0.001 XLM)", value: "0.1 XLM" },
    { label: "Service fee (0.5%)", value: "Variable" },
  ];

  const benefits: BenefitItemProps[] = [
    { icon: <Zap className="w-4 h-4" />, label: "3-5 second settlements" },
    { icon: <DollarSign className="w-4 h-4" />, label: "Ultra-low fees" },
    { icon: <Globe className="w-4 h-4" />, label: "Global accessibility" },
  ];

  return (
    <section className="w-full px-4 py-16">
      {/* Section Header */}
      <div className="text-center mb-10">
        <h2 className="text-4xl font-bold text-white mb-3">Cost Example</h2>
        <p className="text-slate-400 text-base">See exactly what you&apos;ll pay</p>
      </div>

      {/* Card */}
      <div className="max-w-3xl mx-auto bg-slate-900/60 border border-slate-800/70 rounded-2xl p-8">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 md:gap-12">

          {/* Left — Cost Breakdown */}
          <div className="space-y-1">
            <h3 className="text-white font-bold text-lg mb-4">
              Sending 100 Payments
            </h3>
            <div className="space-y-0.5">
              {costRows.map((row) => (
                <CostRow key={row.label} {...row} />
              ))}
            </div>
            <CostRow label="Total Cost" value="~$0.02 + 0.5%" isTotal />
          </div>

          {/* Divider — vertical on desktop, horizontal on mobile */}
          <div className="hidden md:block absolute inset-y-0 left-1/2 -translate-x-1/2 pointer-events-none" />
          <div className="block md:hidden border-t border-slate-800/60" />

          {/* Right — Why Choose Stellar */}
          <div className="space-y-5">
            <h3 className="text-white font-bold text-lg">Why Choose Stellar?</h3>
            <div className="space-y-4">
              {benefits.map((b) => (
                <BenefitItem key={b.label} {...b} />
              ))}
            </div>
          </div>

        </div>
      </div>
    </section>
  );
}