import { LoaderCircle, Trash2 } from "lucide-react";
import { Box, Button, Callout, Flex, Text } from "@radix-ui/themes";
import { useCallback, useEffect, useState } from "react";
import { api } from "./shared/api";

const iconProps = { size: 14, strokeWidth: 2 } as const;

type FoilPackKind = "pack-face" | "pack-face-2";

type PackageInfo = {
  name: string;
  modifiedAt: string;
  saved: boolean;
  result: string;
  kind: string;
  hasProject: boolean;
};

type JobInfo = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  logs: string[];
};

type Props = {
  modelId: string;
  onApplied: () => void;
};

function errorText(text: string): string {
  try {
    const body = JSON.parse(text) as { detail?: unknown };
    if (typeof body.detail === "string" && body.detail.trim()) return body.detail;
  } catch {
    // Response was not JSON.
  }
  return text.trim();
}

function formatWhen(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function slotLabel(kind: string): string {
  if (kind === "pack-face") return "Foil 1";
  if (kind === "pack-face-2") return "Foil 2";
  return "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function FoilPackagesPanel({ modelId, onApplied }: Props) {
  const [packages, setPackages] = useState<PackageInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busyName, setBusyName] = useState("");

  const load = useCallback(async () => {
    const body = await api<{ packages: PackageInfo[] }>(
      `/api/jobs/models/${encodeURIComponent(modelId)}/foil-packages`,
    );
    setPackages(body.packages);
  }, [modelId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    void load()
      .catch((exc: unknown) => {
        if (!cancelled) setError(exc instanceof Error ? errorText(exc.message) : "Could not load packages");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function waitForJob(jobId: string): Promise<JobInfo> {
    for (;;) {
      const job = await api<JobInfo>(`/api/jobs/${encodeURIComponent(jobId)}`);
      const last = [...job.logs].reverse().find((line) => line.trim());
      if (last) setStatus(last);
      if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") {
        return job;
      }
      await sleep(800);
    }
  }

  async function usePackage(pkg: PackageInfo, kind: FoilPackKind) {
    if (busyName) return;
    setBusyName(pkg.name);
    setError("");
    setStatus(kind === "pack-face-2" ? "Rendering this package onto foil 2." : "Rendering this package onto foil 1.");
    try {
      const queued = await api<JobInfo>(
        `/api/jobs/models/${encodeURIComponent(modelId)}/foil-packages/use`,
        { method: "POST", body: JSON.stringify({ name: pkg.name, kind }) },
      );
      const job = await waitForJob(queued.id);
      if (job.status !== "succeeded") {
        const detail = [...job.logs].reverse().find((line) => line.trim()) || "The render failed.";
        throw new Error(detail.replace(/^Job runner error:\s*/, ""));
      }
      setStatus(kind === "pack-face-2" ? "Foil 2 now uses this package." : "Foil 1 now uses this package.");
      onApplied();
      await load();
    } catch (exc: unknown) {
      setStatus("");
      setError(exc instanceof Error ? errorText(exc.message) : "Could not use this package");
    } finally {
      setBusyName("");
    }
  }

  async function removePackage(pkg: PackageInfo) {
    if (busyName) return;
    if (!window.confirm(`Delete the folder “${pkg.name}”? The foil videos stay as they are.`)) return;
    setBusyName(pkg.name);
    setError("");
    setStatus("");
    try {
      await api(`/api/jobs/models/${encodeURIComponent(modelId)}/foil-packages`, {
        method: "DELETE",
        body: JSON.stringify({ name: pkg.name }),
      });
      await load();
    } catch (exc: unknown) {
      setError(exc instanceof Error ? errorText(exc.message) : "Could not delete this package");
    } finally {
      setBusyName("");
    }
  }

  return (
    <Box mt="3">
      <Flex align="center" justify="between" gap="2" mb="2" wrap="wrap">
        <Box>
          <Text as="div" size="2" weight="bold">
            Packages
          </Text>
          <Text as="div" color="gray" size="1">
            Each Create with n8n makes a folder. Use one on foil 1 or foil 2, or delete the extras.
          </Text>
        </Box>
        <Button
          disabled={Boolean(busyName)}
          size="1"
          variant="soft"
          onClick={() => {
            setError("");
            void load().catch((exc: unknown) => {
              setError(exc instanceof Error ? errorText(exc.message) : "Could not load packages");
            });
          }}
        >
          Refresh
        </Button>
      </Flex>
      {error ? (
        <Callout.Root color="red" mb="2" size="1">
          <Callout.Text>{error}</Callout.Text>
        </Callout.Root>
      ) : null}
      {status ? (
        <Text as="div" color="gray" mb="2" size="1">
          {status}
        </Text>
      ) : null}
      {loading ? (
        <Text color="gray" size="1">
          Loading packages…
        </Text>
      ) : packages.length === 0 ? (
        <Text color="gray" size="1">
          No packages for this model yet.
        </Text>
      ) : (
        <Flex direction="column" gap="2">
          {packages.map((pkg) => {
            const slot = slotLabel(pkg.kind);
            const when = formatWhen(pkg.modifiedAt);
            const busy = busyName === pkg.name;
            return (
              <Flex
                key={pkg.name}
                align="center"
                justify="between"
                gap="3"
                wrap="wrap"
                style={{
                  border: "1px solid var(--gray-a5)",
                  borderRadius: 8,
                  padding: "10px 12px",
                }}
              >
                <Box style={{ minWidth: 180, flex: "1 1 220px" }}>
                  <Text as="div" size="2" weight="medium">
                    {pkg.name}
                  </Text>
                  <Text as="div" color="gray" size="1">
                    {[when, pkg.saved ? "Saved" : "Not saved", slot].filter(Boolean).join(" · ")}
                  </Text>
                  {pkg.result ? (
                    <Text as="div" color="gray" size="1">
                      {pkg.result}
                    </Text>
                  ) : null}
                </Box>
                <Flex gap="2" wrap="wrap">
                  <Button
                    disabled={Boolean(busyName) || !pkg.hasProject}
                    size="1"
                    variant="soft"
                    onClick={() => void usePackage(pkg, "pack-face")}
                  >
                    {busy ? <LoaderCircle {...iconProps} /> : null}
                    Use on foil 1
                  </Button>
                  <Button
                    disabled={Boolean(busyName) || !pkg.hasProject}
                    size="1"
                    variant="soft"
                    onClick={() => void usePackage(pkg, "pack-face-2")}
                  >
                    Use on foil 2
                  </Button>
                  <Button
                    color="red"
                    disabled={Boolean(busyName)}
                    size="1"
                    variant="soft"
                    onClick={() => void removePackage(pkg)}
                  >
                    <Trash2 {...iconProps} />
                    Delete
                  </Button>
                </Flex>
              </Flex>
            );
          })}
        </Flex>
      )}
    </Box>
  );
}
