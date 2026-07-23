"use client";

import { useState } from "react";
import { useStore } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Cable,
  Camera,
  CircleCheck,
  CircleX,
  Loader2,
  Unplug,
} from "lucide-react";

export function ConnectPanel() {
  const store = useStore();
  const [host, setHost] = useState("");
  const [port, setPort] = useState("80");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const connecting = store.phase === "connecting";
  const connected = store.phase === "connected";

  if (connected && store.connection) {
    const d = store.connection.device;
    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="inline-flex items-center gap-2 text-sm font-medium">
          <span className="relative flex size-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
            <span className="relative inline-flex size-2.5 rounded-full bg-success" />
          </span>
          {d.manufacturer} {d.model}
        </span>
        <span className="font-mono text-xs text-soft-foreground">
          {store.connection.host}:{store.connection.port} · fw {d.firmware} · sn{" "}
          {d.serial}
        </span>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => store.disconnect()}
          disabled={store.running}
        >
          <Unplug data-icon="inline-start" />
          Disconnect
        </Button>
      </div>
    );
  }

  return (
    <Card className="mx-auto w-full max-w-lg rounded-squircle-2xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Camera className="size-5 text-primary" />
          Connect to camera
        </CardTitle>
        <CardDescription>
          Enter the ONVIF endpoint and credentials. Capabilities are discovered
          automatically on connect.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            store.connect(host.trim(), Number(port) || 80, username, password);
          }}
        >
          <div className="grid grid-cols-[1fr_6.5rem] gap-2">
            <Input
              placeholder="Camera IP / hostname"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              required
              autoFocus
            />
            <Input
              placeholder="Port"
              value={port}
              inputMode="numeric"
              onChange={(e) => setPort(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Input
              placeholder="Username"
              value={username}
              autoComplete="off"
              onChange={(e) => setUsername(e.target.value)}
            />
            <Input
              placeholder="Password"
              type="password"
              value={password}
              autoComplete="off"
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {store.phase === "error" && store.connectionError && (
            <div className="flex items-start gap-2 rounded-squircle-md rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <CircleX className="mt-0.5 size-4 shrink-0" />
              <span className="break-all">{store.connectionError}</span>
            </div>
          )}
          <Button type="submit" disabled={connecting || !host.trim()}>
            {connecting ? (
              <>
                <Loader2 className="animate-spin" data-icon="inline-start" />
                Connecting…
              </>
            ) : (
              <>
                <Cable data-icon="inline-start" />
                Connect
              </>
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export function CapabilityChips() {
  const { connection } = useStore();
  if (!connection) return null;
  const c = connection.capabilities;
  const items: { label: string; on: boolean }[] = [
    { label: "Absolute P/T", on: c.absolutePanTilt },
    { label: "Relative P/T", on: c.relativePanTilt },
    { label: "Continuous P/T", on: c.continuousPanTilt },
    { label: "Zoom", on: c.absoluteZoom },
    { label: "Home", on: c.homeSupported },
    { label: `${c.maxPresets} presets`, on: c.maxPresets > 0 },
  ];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {items.map((i) => (
        <Badge
          key={i.label}
          variant={i.on ? "secondary" : "ghost"}
          className={
            i.on ? "text-foreground" : "text-disabled-foreground line-through"
          }
        >
          {i.on ? (
            <CircleCheck className="text-success" />
          ) : (
            <CircleX />
          )}
          {i.label}
        </Badge>
      ))}
    </div>
  );
}
