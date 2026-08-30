import React from "react";
import { Shield, Target, Activity, HandHeart } from "lucide-react";

const values = [
  {
    icon: Shield,
    title: "Security-First Design",
    description:
      "Non-custodial architecture means you maintain full control of your private keys. We never have access to your funds, and all sensitive operations happen client-side with end-to-end encryption.",
  },
  {
    icon: Target,
    title: "Accuracy in Transactions",
    description:
      "Multi-layer validation ensures every payment is accurate before execution. Duplicate detection, balance verification, and address validation eliminate human error from the equation.",
  },
  {
    icon: Activity,
    title: "Reliability & Scalability",
    description:
      "Built on Stellar's battle-tested infrastructure with 99.9% uptime. Whether you're processing 10 payments or 10,000, our system handles your operations with consistent performance.",
  },
  {
    icon: HandHeart,
    title: "User Control & Transparency",
    description:
      "Complete visibility into fees, transaction status, and system operations. You maintain full control over approval workflows, spending limits, and team permissions at all times.",
  },
];

export function ValuesSection() {
  return (
    <section className="bg-[#0a0e1a] max-h-screen text-white py-24 px-6 md:px-12 lg:px-24">
      <div className="max-w-6xl mx-auto flex flex-col items-center">
        {/* Header Section */}
        <div className="text-center mb-16 max-w-2xl">
          <div className="inline-flex items-center justify-center px-4 py-1.5 mb-6 rounded-full bg-[#052e16] border border-[#064e3b]">
            <span className="text-sm font-medium text-[#10b981]">
              Our Values
            </span>
          </div>

          <h2 className="text-4xl md:text-5xl font-bold tracking-tight mb-6 text-white">
            Built on Trust and Precision
          </h2>

          <p className="text-lg text-[#a1a1aa] leading-relaxed">
            Financial operations demand the highest standards. We&apos;ve engineered
            every aspect of our platform with security, accuracy, and user
            control in mind.
          </p>
        </div>

        {/* Feature Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-12">
          {values.map((value, index) => {
            const Icon = value.icon;
            return (
              <div
                key={index}
                className="flex flex-col sm:flex-row gap-6 items-start"
              >
                <div className="flex-shrink-0 flex items-center justify-center mt-1 w-14 h-14 rounded-2xl bg-[#0f172a] border border-[#1e293b]">
                  <Icon className="w-6 h-6 text-[#10b981]" strokeWidth={2.5} />
                </div>
                <div>
                  <h3 className="text-xl font-semibold mb-3 text-white">
                    {value.title}
                  </h3>
                  <p className="text-base text-[#a1a1aa] leading-relaxed">
                    {value.description}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
