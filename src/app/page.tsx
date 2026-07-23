"use client";

import Link from "next/link";
import { useStore } from "@/lib/store";
import { ConnectPanel, CapabilityChips } from "@/components/console/connect-panel";
import { TestRunner } from "@/components/console/test-runner";
import { LivePanel, PositionViz } from "@/components/console/live-panel";
import { Joystick } from "@/components/console/joystick";
import { CallTicker } from "@/components/console/call-ticker";
import { ThemeToggle } from "@/components/console/theme-toggle";
import { Button } from "@/components/ui/button";
import { History, ScanEye } from "lucide-react";

export default function ConsolePage() {
  const store = useStore();
  const connected = store.phase === "connected";

  return (
    <div className="flex min-h-dvh flex-col pb-14">
      <header className="sticky top-0 z-30 border-b bg-background/85 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3">
          <ScanEye className="size-5 text-primary" />
          <div className="mr-auto">
            <h1 className="text-sm font-semibold leading-tight">
              ONVIF Camera Testing Console
            </h1>
            <p className="text-[11px] text-placeholder-foreground">
              PTZ workflow verification · status transitions · reports
            </p>
          </div>
          <Button variant="ghost" size="sm" asChild>
            <Link href="/history">
              <History data-icon="inline-start" />
              History
            </Link>
          </Button>
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">
        {!connected ? (
          <div className="flex min-h-[60vh] items-center justify-center">
            <ConnectPanel />
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <ConnectPanel />
              <CapabilityChips />
            </div>
            <div className="flex flex-col gap-4 lg:flex-row">
              <TestRunner />
              <aside className="flex w-full shrink-0 flex-col gap-3 lg:w-90">
                <LivePanel />
                <PositionViz />
                <Joystick />
              </aside>
            </div>
          </div>
        )}
      </main>

      <CallTicker />
    </div>
  );
}
