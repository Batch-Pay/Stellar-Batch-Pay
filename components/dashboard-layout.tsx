"use client"

import * as React from "react"
import { AppSidebar } from "./app-sidebar"
import { AppHeader } from "./app-header"
import { WalletGate } from "@/components/dashboard/WalletGate"
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar"
import { NotificationsProvider } from "@/contexts/NotificationsContext"
import { WalletSessionProvider } from "@/contexts/WalletSessionContext"

export function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <NotificationsProvider>
      <WalletSessionProvider>
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-emerald-500 focus:px-4 focus:py-2 focus:text-black focus:outline-none focus:ring-2 focus:ring-emerald-200"
        >
          Skip to main content
        </a>
        <SidebarProvider defaultOpen={true}>
          <div className="flex min-h-screen w-full bg-background text-foreground">
            <AppSidebar />
            <SidebarInset className="flex flex-col bg-transparent">
              <AppHeader />
              <main id="main-content" className="flex-1 px-4 md:px-8 py-8">
                <div className="mx-auto w-full max-w-[1200px]">
                  <WalletGate>{children}</WalletGate>
                </div>
              </main>
            </SidebarInset>
          </div>
        </SidebarProvider>
      </WalletSessionProvider>
    </NotificationsProvider>
  )
}
