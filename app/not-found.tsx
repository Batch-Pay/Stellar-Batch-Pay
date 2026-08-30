"use client";

import React from "react";
import Link from "next/link";
import { Home, Globe, BookOpen, Headset } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Navbar } from "@/components/landing/navbar";

export default function NotFound() {
  return (
    <>
      <Navbar />
      <div className="min-h-screen md:h-[90vh] bg-[#020B0D] text-white flex flex-col items-center selection:bg-[#00D4AA]/30 overflow-hidden relative">
        {/* Background Effects */}
        <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none">
          <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-[#00D4AA]/10 rounded-full blur-[120px]" />
          <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-[#00D4AA]/5 rounded-full blur-[120px]" />

          {/* Subtle dots/stars effect */}
          <div className="absolute top-[20%] left-[10%] w-1 h-1 bg-[#00D4AA]/40 rounded-full" />
          <div className="absolute top-[60%] right-[15%] w-1 h-1 bg-[#00D4AA]/30 rounded-full" />
          <div className="absolute bottom-[20%] left-[25%] w-1.5 h-1.5 bg-[#00D4AA]/20 rounded-full" />
          <div className="absolute bottom-[10%] right-[30%] w-1 h-1 bg-[#00D4AA]/10 rounded-full" />
        </div>

        <main className="flex-1 flex flex-col items-center justify-center relative z-10 px-6 mt-20">
          <div className="relative flex flex-col items-center">
            {/* Large Faded 404 Text */}
            <h1 className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-[180px] md:text-[220px] font-black text-[#10B981]/30 select-none tracking-tight leading-none pointer-events-none">
              404
            </h1>

            {/* Main Content */}
            <div className="text-center space-y-12 max-w-2xl relative">
              <h2 className="text-[48px] md:text-6xl font-bold tracking-tight">
                Page Not Found
              </h2>
              <p className="text-white text-lg md:text-xl max-w-[473px] font-medium leading-relaxed mb-10">
                The page you&apos;re looking for may have been moved, deleted, or
                entered incorrectly.
              </p>

              {/* Primary Actions */}
              <div className="flex flex-col sm:flex-row gap-4 justify-center items-center pt-8">
                <Button
                  asChild
                  className="bg-[#10B981] hover:bg-[#00B894] text-[#020B0D] font-bold px-8 py-6 rounded-2xl transition-all duration-300 shadow-[0_8px_25px_rgba(0,212,170,0.3)] hover:scale-105 active:scale-95 flex items-center gap-3 w-full sm:w-auto"
                >
                  <Link href="/dashboard">
                    <Home size={20} strokeWidth={2.5} />
                    Return to Dashboard
                  </Link>
                </Button>

                <Button
                  asChild
                  variant="outline"
                  className="bg-[#334155]/80 hover:bg-[#10B981] border-white/30 hover:border-[#00D4AA]/30 text-white font-semibold px-8 py-6 rounded-2xl transition-all duration-300 hover:scale-105 active:scale-95 flex items-center gap-3 w-full sm:w-auto"
                >
                  <Link href="/">
                    <Globe size={20} />
                    Go to Homepage
                  </Link>
                </Button>
              </div>
            </div>
          </div>

          {/* Secondary Links */}
          <div className="mt-24 md:mt-32 flex flex-wrap justify-center gap-8 md:gap-12">
            <Link
              href="/docs"
              className="group flex items-center gap-3 text-gray-500 hover:text-white transition-all duration-300"
            >
              <div className="p-2.5 rounded-xl bg-white/5 group-hover:bg-[#00D4AA]/10 transition-colors">
                <BookOpen size={18} className="group-hover:text-[#00D4AA]" />
              </div>
              <span className="font-medium text-sm md:text-base">
                View Documentation
              </span>
            </Link>

            <Link
              href="/contact"
              className="group flex items-center gap-3 text-gray-500 hover:text-white transition-all duration-300"
            >
              <div className="p-2.5 rounded-xl bg-white/5 group-hover:bg-[#00D4AA]/10 transition-colors">
                <Headset size={18} className="group-hover:text-[#00D4AA]" />
              </div>
              <span className="font-medium text-sm md:text-base">
                Contact Support
              </span>
            </Link>
          </div>
        </main>

        {/* Footer Decoration */}
        <footer className="w-full py-10 flex justify-center opacity-20 pointer-events-none">
          <div className="w-px h-12 bg-gradient-to-b from-transparent via-[#00D4AA] to-transparent" />
        </footer>
      </div>
    </>
  );
}
