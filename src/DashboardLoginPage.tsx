import { KeyRound, LoaderCircle, LogIn, LogOut } from "lucide-react";
import {
  Box,
  Button,
  Callout,
  Card,
  Container,
  Flex,
  Heading,
  Text,
  TextField,
} from "@radix-ui/themes";
import { FormEvent, useEffect, useState } from "react";
import { fetchOperatorSession, operatorLogin, operatorLogout } from "./shared/api";

const iconProps = { size: 16, strokeWidth: 2 } as const;

function nextPath(): string {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("next") || "/dashboard";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/dashboard";
  if (!raw.startsWith("/dashboard")) return "/dashboard";
  return raw;
}

export function DashboardLoginPage() {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchOperatorSession()
      .then((ok) => {
        if (!cancelled) setSignedIn(ok);
      })
      .catch(() => {
        if (!cancelled) setSignedIn(false);
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await operatorLogin(token);
      window.location.assign(nextPath());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(false);
    }
  }

  async function handleLogout() {
    setBusy(true);
    setError("");
    try {
      await operatorLogout();
      setSignedIn(false);
      setToken("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="dashboard-root">
      <Container size="2">
        <Flex direction="column" gap="4" py="9" align="center">
          <Box style={{ width: "100%", maxWidth: 420 }}>
            <Text className="eyebrow" size="2">
              Sugar Scratchie
            </Text>
            <Heading size="7" mb="2">
              Dashboard login
            </Heading>
            <Text color="gray" size="2" mb="4" as="p">
              Enter the operator token (`DASHBOARD_TOKEN`) to unlock admin pages. It is stored in an
              httpOnly cookie — not in the page bundle.
            </Text>

            {checking ? (
              <Flex align="center" gap="2">
                <LoaderCircle className="spin" {...iconProps} />
                <Text size="2" color="gray">
                  Checking session…
                </Text>
              </Flex>
            ) : signedIn ? (
              <Card>
                <Flex direction="column" gap="3" p="4">
                  <Text size="2">You are signed in as an operator.</Text>
                  <Flex gap="2" wrap="wrap">
                    <Button asChild>
                      <a href={nextPath()}>
                        <LogIn {...iconProps} />
                        Continue
                      </a>
                    </Button>
                    <Button color="gray" variant="soft" disabled={busy} onClick={() => void handleLogout()}>
                      <LogOut {...iconProps} />
                      Sign out
                    </Button>
                  </Flex>
                </Flex>
              </Card>
            ) : (
              <Card>
                <form onSubmit={(event) => void handleSubmit(event)}>
                  <Flex direction="column" gap="3" p="4">
                    <TextField.Root
                      type="password"
                      autoComplete="current-password"
                      placeholder="Dashboard token"
                      value={token}
                      onChange={(event) => setToken(event.target.value)}
                      required
                      size="3"
                    >
                      <TextField.Slot>
                        <KeyRound {...iconProps} />
                      </TextField.Slot>
                    </TextField.Root>
                    {error ? (
                      <Callout.Root color="red" size="1">
                        <Callout.Text>{error}</Callout.Text>
                      </Callout.Root>
                    ) : null}
                    <Button type="submit" disabled={busy || !token.trim()} size="3">
                      {busy ? <LoaderCircle className="spin" {...iconProps} /> : <LogIn {...iconProps} />}
                      Sign in
                    </Button>
                  </Flex>
                </form>
              </Card>
            )}
          </Box>
        </Flex>
      </Container>
    </main>
  );
}
