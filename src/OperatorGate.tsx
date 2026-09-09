import { LoaderCircle } from "lucide-react";
import { Box, Flex, Text } from "@radix-ui/themes";
import { type ReactNode, useEffect, useState } from "react";
import { fetchOperatorSession } from "./shared/api";

type Props = {
  children: ReactNode;
};

/**
 * Gates /dashboard/* behind an operator cookie (or optional VITE_DASHBOARD_TOKEN).
 * Login lives at /dashboard/login and is not wrapped.
 */
export function OperatorGate({ children }: Props) {
  const [state, setState] = useState<"checking" | "ok" | "denied">("checking");

  useEffect(() => {
    let cancelled = false;
    fetchOperatorSession()
      .then((ok) => {
        if (cancelled) return;
        if (ok) {
          setState("ok");
          return;
        }
        setState("denied");
        const next = `${window.location.pathname}${window.location.search}`;
        const login = `/dashboard/login?next=${encodeURIComponent(next)}`;
        window.history.replaceState(null, "", login);
        window.dispatchEvent(new PopStateEvent("popstate"));
      })
      .catch(() => {
        if (cancelled) return;
        setState("denied");
        const next = `${window.location.pathname}${window.location.search}`;
        const login = `/dashboard/login?next=${encodeURIComponent(next)}`;
        window.history.replaceState(null, "", login);
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === "ok") return <>{children}</>;

  return (
    <main className="dashboard-root">
      <Flex align="center" justify="center" style={{ minHeight: "40vh" }}>
        <Box>
          <Flex align="center" gap="2">
            <LoaderCircle className="spin" size={16} strokeWidth={2} />
            <Text size="2" color="gray">
              Checking operator access…
            </Text>
          </Flex>
        </Box>
      </Flex>
    </main>
  );
}
