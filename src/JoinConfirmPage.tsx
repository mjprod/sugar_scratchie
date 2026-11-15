import { CheckCircle2, LoaderCircle, UserRound } from "lucide-react";
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
import { FormEvent, useEffect, useMemo, useState } from "react";

const iconProps = { size: 16, strokeWidth: 2 } as const;

type InviteInfo = {
  ok: boolean;
  inviteCode: string;
  campaignName: string | null;
  inviteeEmail: string | null;
};

type ConfirmResult = {
  ok: boolean;
  fullName: string;
  email: string;
  surveyStep: number;
  status: string;
};

function readQuery(): { inviteCode: string; inviteeEmail: string } {
  const params = new URLSearchParams(window.location.search);
  return {
    inviteCode: (params.get("inviteCode") || "").trim(),
    inviteeEmail: (params.get("inviteeEmail") || "").trim(),
  };
}

function detailFromError(text: string, status: number): string {
  try {
    const body = JSON.parse(text) as { detail?: unknown };
    if (typeof body.detail === "string" && body.detail.trim()) {
      return body.detail.trim();
    }
  } catch {
    /* plain text */
  }
  if (text.trim()) return text.trim();
  return status === 404 ? "This invite is not valid." : "Something went wrong.";
}

export function JoinConfirmPage() {
  const initial = useMemo(() => readQuery(), []);
  const [inviteCode] = useState(initial.inviteCode);
  const [email, setEmail] = useState(initial.inviteeEmail);
  const [fullName, setFullName] = useState("");
  const [campaignName, setCampaignName] = useState<string | null>(null);
  const [loadingInvite, setLoadingInvite] = useState(Boolean(initial.inviteCode));
  const [inviteError, setInviteError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [result, setResult] = useState<ConfirmResult | null>(null);

  useEffect(() => {
    if (!inviteCode) {
      setInviteError("This invite link is missing a code.");
      setLoadingInvite(false);
      return;
    }
    let cancelled = false;
    setLoadingInvite(true);
    setInviteError("");
    fetch(`/api/promoter/invites/${encodeURIComponent(inviteCode)}`)
      .then(async (response) => {
        const text = await response.text();
        if (!response.ok) {
          throw new Error(detailFromError(text, response.status));
        }
        return JSON.parse(text) as InviteInfo;
      })
      .then((info) => {
        if (cancelled) return;
        setCampaignName(info.campaignName);
        setEmail((current) => current || info.inviteeEmail || "");
      })
      .catch((caught) => {
        if (cancelled) return;
        setInviteError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (!cancelled) setLoadingInvite(false);
      });
    return () => {
      cancelled = true;
    };
  }, [inviteCode]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setSaveError("");
    try {
      const response = await fetch("/api/promoter/pre-influencers/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          invite_code: inviteCode,
          email: email.trim(),
          full_name: fullName.trim(),
        }),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(detailFromError(text, response.status));
      }
      const body = JSON.parse(text) as ConfirmResult;
      setResult(body);
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="dashboard-root">
      <Container size="2">
        <Flex direction="column" gap="4" py="9" align="center">
          <Box style={{ width: "100%", maxWidth: 440 }}>
            <Text className="eyebrow" size="2">
              Sugar Scratchie
            </Text>
            <Heading size="7" mb="2">
              Confirm email & name
            </Heading>
            <Text color="gray" size="2" mb="4" as="p">
              {campaignName
                ? `You were invited to ${campaignName}. Confirm your details to continue.`
                : "Confirm the email and name from your invite to continue onboarding."}
            </Text>

            {loadingInvite ? (
              <Card>
                <Flex align="center" gap="2" p="4">
                  <LoaderCircle {...iconProps} className="spin" />
                  <Text size="2">Checking invite…</Text>
                </Flex>
              </Card>
            ) : null}

            {inviteError ? (
              <Callout.Root color="red">
                <Callout.Text>{inviteError}</Callout.Text>
              </Callout.Root>
            ) : null}

            {result ? (
              <Card>
                <Flex direction="column" gap="3" p="4">
                  <Flex align="center" gap="2">
                    <CheckCircle2 {...iconProps} />
                    <Heading size="4">Saved</Heading>
                  </Flex>
                  <Text size="2" color="gray">
                    Thanks, {result.fullName}. Your account manager can order your landing page
                    next.
                  </Text>
                  <Text size="2">
                    {result.email} · step {result.surveyStep}/2
                  </Text>
                </Flex>
              </Card>
            ) : null}

            {!loadingInvite && !inviteError && !result ? (
              <Card>
                <form onSubmit={handleSubmit}>
                  <Flex direction="column" gap="3" p="4">
                    <label>
                      <Text size="2" weight="medium" mb="1" as="div">
                        Email
                      </Text>
                      <TextField.Root
                        type="email"
                        required
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        placeholder="you@example.com"
                        autoComplete="email"
                      />
                    </label>
                    <label>
                      <Text size="2" weight="medium" mb="1" as="div">
                        Full name
                      </Text>
                      <TextField.Root
                        required
                        value={fullName}
                        onChange={(event) => setFullName(event.target.value)}
                        placeholder="Your name"
                        autoComplete="name"
                      />
                    </label>
                    {saveError ? (
                      <Callout.Root color="red">
                        <Callout.Text>{saveError}</Callout.Text>
                      </Callout.Root>
                    ) : null}
                    <Button type="submit" disabled={busy || !inviteCode}>
                      {busy ? (
                        <LoaderCircle {...iconProps} className="spin" />
                      ) : (
                        <UserRound {...iconProps} />
                      )}
                      {busy ? "Saving…" : "Confirm & save"}
                    </Button>
                  </Flex>
                </form>
              </Card>
            ) : null}
          </Box>
        </Flex>
      </Container>
    </main>
  );
}
