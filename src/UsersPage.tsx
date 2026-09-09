import {
  AlertTriangle,
  Ban,
  ExternalLink,
  Home,
  LoaderCircle,
  ShieldCheck,
  Trash2,
  Users,
  Wallet,
} from "lucide-react";
import {
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Container,
  Flex,
  Grid,
  Heading,
  Select,
  Table,
  Text,
  TextField,
} from "@radix-ui/themes";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  adjustUserWallet,
  deleteUserPermanently,
  fetchUser,
  fetchUsers,
  patchUser,
  revokeUserSessions,
  type AdminUser,
  type UserStatus,
  type WalletCurrency,
  type WalletTransaction,
} from "./shared/users";
import { operatorLogout } from "./shared/api";

const iconProps = { size: 16, strokeWidth: 2 } as const;
const PAGE_SIZE = 50;

function formatWhen(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function statusColor(status: UserStatus): "green" | "red" | "gray" {
  if (status === "active") return "green";
  if (status === "banned") return "red";
  return "gray";
}

export function UsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<UserStatus | "">("");
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<AdminUser | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [transactions, setTransactions] = useState<WalletTransaction[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [currency, setCurrency] = useState<WalletCurrency>("diamonds");
  const [delta, setDelta] = useState("10");
  const [note, setNote] = useState("");
  const [editDisplayName, setEditDisplayName] = useState("");
  const [editUsername, setEditUsername] = useState("");
  const detailRef = useRef<HTMLDivElement | null>(null);
  const pendingWalletAdjustRef = useRef<{
    requestSignature: string;
    idempotencyKey: string;
  } | null>(null);

  function selectUser(user: AdminUser) {
    setSelectedId(user.id);
    // Show list-row data immediately so the panel is visible before detail fetch.
    setSelected(user);
    setEditDisplayName(user.displayName ?? "");
    setEditUsername(user.username ?? "");
    setTransactions([]);
    requestAnimationFrame(() => {
      detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  const refreshList = useCallback(async () => {
    const data = await fetchUsers({
      q: query,
      status: statusFilter,
      limit: PAGE_SIZE,
      offset,
    });
    setUsers(data.users);
    setTotal(data.total);
  }, [offset, query, statusFilter]);

  const refreshDetail = useCallback(async (userId: string) => {
    setDetailLoading(true);
    try {
      const data = await fetchUser(userId);
      setSelected(data.user);
      setEditDisplayName(data.user.displayName ?? "");
      setEditUsername(data.user.username ?? "");
      setTransactions(data.transactions);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshList().catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
  }, [refreshList]);

  useEffect(() => {
    if (!selectedId) {
      setSelected(null);
      setTransactions([]);
      setEditDisplayName("");
      setEditUsername("");
      return;
    }
    refreshDetail(selectedId).catch((caught) =>
      setError(caught instanceof Error ? caught.message : String(caught)),
    );
  }, [refreshDetail, selectedId]);

  async function runAction(action: () => Promise<void>): Promise<boolean> {
    setBusy(true);
    setError("");
    try {
      await action();
      await refreshList();
      if (selectedId) await refreshDetail(selectedId);
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function handleProfileSave() {
    if (!selected) return;
    await runAction(async () => {
      await patchUser(selected.id, {
        display_name: editDisplayName.trim() || null,
        username: editUsername.trim() || null,
      });
    });
  }

  async function handleStatus(next: UserStatus) {
    if (!selected) return;
    const label =
      next === "banned" ? "Ban" : next === "deleted" ? "Soft-delete" : "Reactivate";
    if (!window.confirm(`${label} user “${selected.email}”?`)) return;
    await runAction(async () => {
      await patchUser(selected.id, { status: next });
    });
  }

  async function handleRevokeSessions() {
    if (!selected) return;
    if (!window.confirm(`Revoke all sessions for “${selected.email}”?`)) return;
    await runAction(async () => {
      await revokeUserSessions(selected.id);
    });
  }

  async function handlePermanentDelete() {
    if (!selected) return;
    const email = selected.email;
    if (
      !window.confirm(
        `Permanently delete “${email}” and all wallet/pack/session data?\n\nThis cannot be undone.`,
      )
    ) {
      return;
    }
    const typed = window.prompt(`Type the email to confirm permanent delete:\n${email}`);
    if (typed?.trim().toLowerCase() !== email.toLowerCase()) {
      setError("Permanent delete cancelled — email did not match.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await deleteUserPermanently(selected.id);
      setSelectedId(null);
      setSelected(null);
      setTransactions([]);
      setEditDisplayName("");
      setEditUsername("");
      await refreshList();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleWalletAdjust() {
    if (!selected) return;
    const amount = Number(delta);
    if (!Number.isFinite(amount) || amount === 0 || !Number.isInteger(amount)) {
      setError("Wallet delta must be a non-zero integer.");
      return;
    }
    const trimmedNote = note.trim();
    const requestSignature = JSON.stringify({
      userId: selected.id,
      currency,
      delta: amount,
      note: trimmedNote,
    });
    const idempotencyKey =
      pendingWalletAdjustRef.current?.requestSignature === requestSignature
        ? pendingWalletAdjustRef.current.idempotencyKey
        : crypto.randomUUID();
    pendingWalletAdjustRef.current = { requestSignature, idempotencyKey };
    const ok = await runAction(async () => {
      await adjustUserWallet(selected.id, {
        currency,
        delta: amount,
        note: trimmedNote || undefined,
        idempotency_key: idempotencyKey,
      });
    });
    // Only drop the pending key after refresh succeeds. If refresh fails, the UI
    // still shows the old balance; retry must reuse the same idempotency key.
    if (ok) {
      pendingWalletAdjustRef.current = null;
      setNote("");
    }
  }

  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + PAGE_SIZE, total);

  return (
    <main className="dashboard-root">
      <Container size="4">
        <Flex direction="column" gap="4" py="6">
          <Flex align="center" justify="between" wrap="wrap" gap="3">
            <Box>
              <Text className="eyebrow" size="2">
                Sugar Scratchie
              </Text>
              <Heading size="7">Users</Heading>
              <Text color="gray" size="2">
                Search player accounts, change status, revoke sessions, and adjust wallets.
              </Text>
            </Box>
            <Flex gap="2" wrap="wrap">
              <Button
                color="gray"
                variant="soft"
                onClick={() =>
                  refreshList().catch((caught) =>
                    setError(caught instanceof Error ? caught.message : String(caught)),
                  )
                }
              >
                <LoaderCircle {...iconProps} />
                Refresh
              </Button>
              <Button asChild variant="soft">
                <a href="/dashboard/models">Models</a>
              </Button>
              <Button asChild variant="soft">
                <a href="/dashboard/themes">Themes</a>
              </Button>
              <Button asChild variant="soft">
                <a href="/dashboard">
                  <ExternalLink {...iconProps} />
                  Dashboard
                </a>
              </Button>
              <Button
                color="gray"
                variant="outline"
                onClick={() => {
                  void operatorLogout().finally(() => {
                    window.location.assign("/dashboard/login");
                  });
                }}
              >
                Sign out
              </Button>
              <Button asChild>
                <a href="/">
                  <Home {...iconProps} />
                  Home
                </a>
              </Button>
            </Flex>
          </Flex>

          {error ? (
            <Callout.Root color="red">
              <Callout.Icon>
                <AlertTriangle {...iconProps} />
              </Callout.Icon>
              <Callout.Text>{error}</Callout.Text>
            </Callout.Root>
          ) : null}

          {selected ? (
            <Card ref={detailRef}>
              <Flex align="center" justify="between" gap="3" wrap="wrap" mb="4">
                <Box>
                  <Heading as="h2" size="4">
                    {selected.displayName || selected.username || selected.email}
                  </Heading>
                  <Text color="gray" size="2">
                    {selected.email} · id {selected.id}
                    {detailLoading ? " · loading…" : ""}
                  </Text>
                </Box>
                <Flex align="center" gap="2" wrap="wrap">
                  <Badge color={statusColor(selected.status)} size="2" variant="soft">
                    {selected.status}
                  </Badge>
                  <Button
                    color="gray"
                    variant="soft"
                    size="1"
                    onClick={() => {
                      setSelectedId(null);
                      setSelected(null);
                      setTransactions([]);
                      setEditDisplayName("");
                      setEditUsername("");
                    }}
                  >
                    Close
                  </Button>
                </Flex>
              </Flex>

              <Grid columns={{ initial: "1", sm: "2", md: "4" }} gap="3" mb="4">
                <Box>
                  <Text as="div" size="1" color="gray">
                    Provider
                  </Text>
                  <Text size="2">{selected.provider}</Text>
                </Box>
                <Box>
                  <Text as="div" size="1" color="gray">
                    Created
                  </Text>
                  <Text size="2">{formatWhen(selected.createdAt)}</Text>
                </Box>
                <Box>
                  <Text as="div" size="1" color="gray">
                    Last seen
                  </Text>
                  <Text size="2">{formatWhen(selected.lastSeenAt)}</Text>
                </Box>
                <Box>
                  <Text as="div" size="1" color="gray">
                    Active sessions
                  </Text>
                  <Text size="2">{selected.activeSessions ?? "—"}</Text>
                </Box>
              </Grid>

              <Heading as="h3" size="3" mb="2">
                Profile
              </Heading>
              <Grid columns={{ initial: "1", sm: "3" }} gap="2" mb="3" align="end">
                <label>
                  <Text as="div" mb="1" size="1" weight="medium" color="gray">
                    Display name
                  </Text>
                  <TextField.Root
                    disabled={busy}
                    value={editDisplayName}
                    onChange={(event) => setEditDisplayName(event.currentTarget.value)}
                  />
                </label>
                <label>
                  <Text as="div" mb="1" size="1" weight="medium" color="gray">
                    Username
                  </Text>
                  <TextField.Root
                    disabled={busy}
                    value={editUsername}
                    onChange={(event) => setEditUsername(event.currentTarget.value)}
                  />
                </label>
                <Button disabled={busy} onClick={() => handleProfileSave()}>
                  Save profile
                </Button>
              </Grid>

              <Flex gap="2" wrap="wrap" mb="4">
                {selected.status !== "active" ? (
                  <Button
                    disabled={busy}
                    variant="soft"
                    color="green"
                    onClick={() => handleStatus("active")}
                  >
                    <ShieldCheck {...iconProps} />
                    Reactivate
                  </Button>
                ) : null}
                {selected.status !== "banned" ? (
                  <Button
                    disabled={busy}
                    variant="soft"
                    color="red"
                    onClick={() => handleStatus("banned")}
                  >
                    <Ban {...iconProps} />
                    Ban
                  </Button>
                ) : null}
                {selected.status !== "deleted" ? (
                  <Button
                    disabled={busy}
                    variant="soft"
                    color="gray"
                    onClick={() => handleStatus("deleted")}
                  >
                    Soft delete
                  </Button>
                ) : null}
                <Button
                  disabled={busy}
                  variant="soft"
                  color="gray"
                  onClick={() => handleRevokeSessions()}
                >
                  Revoke sessions
                </Button>
                <Button
                  disabled={busy}
                  color="red"
                  onClick={() => handlePermanentDelete()}
                >
                  <Trash2 {...iconProps} />
                  Delete permanently
                </Button>
              </Flex>

              <Flex align="center" gap="2" mb="2">
                <Wallet {...iconProps} />
                <Heading as="h3" size="3">
                  Wallet adjust
                </Heading>
              </Flex>
              <Text as="p" size="2" color="gray" mb="3">
                Current balance: {selected.wallet.diamonds} diamonds · {selected.wallet.coins}{" "}
                coins
              </Text>
              <Grid columns={{ initial: "1", sm: "4" }} gap="2" mb="3" align="end">
                <label>
                  <Text as="div" mb="1" size="1" weight="medium" color="gray">
                    Currency
                  </Text>
                  <Select.Root
                    value={currency}
                    onValueChange={(value) => setCurrency(value as WalletCurrency)}
                  >
                    <Select.Trigger />
                    <Select.Content>
                      <Select.Item value="diamonds">Diamonds</Select.Item>
                      <Select.Item value="coins">Coins</Select.Item>
                    </Select.Content>
                  </Select.Root>
                </label>
                <label>
                  <Text as="div" mb="1" size="1" weight="medium" color="gray">
                    Delta
                  </Text>
                  <TextField.Root
                    disabled={busy}
                    type="number"
                    value={delta}
                    onChange={(event) => setDelta(event.currentTarget.value)}
                  />
                </label>
                <label style={{ gridColumn: "span 2" }}>
                  <Text as="div" mb="1" size="1" weight="medium" color="gray">
                    Note (optional)
                  </Text>
                  <TextField.Root
                    disabled={busy}
                    placeholder="support credit"
                    value={note}
                    onChange={(event) => setNote(event.currentTarget.value)}
                  />
                </label>
              </Grid>
              <Button disabled={busy} mb="4" onClick={() => handleWalletAdjust()}>
                Apply adjustment
              </Button>

              <Heading as="h3" size="3" mb="2">
                Recent transactions
              </Heading>
              {transactions.length === 0 ? (
                <Text color="gray" size="2">
                  {detailLoading ? "Loading…" : "No wallet transactions yet."}
                </Text>
              ) : (
                <Box style={{ overflow: "auto", maxHeight: 240 }}>
                  <Table.Root size="1" variant="surface">
                    <Table.Header>
                      <Table.Row>
                        <Table.ColumnHeaderCell>When</Table.ColumnHeaderCell>
                        <Table.ColumnHeaderCell>Currency</Table.ColumnHeaderCell>
                        <Table.ColumnHeaderCell>Delta</Table.ColumnHeaderCell>
                        <Table.ColumnHeaderCell>Balance</Table.ColumnHeaderCell>
                        <Table.ColumnHeaderCell>Reason</Table.ColumnHeaderCell>
                      </Table.Row>
                    </Table.Header>
                    <Table.Body>
                      {transactions.map((tx) => (
                        <Table.Row key={tx.id}>
                          <Table.Cell>{formatWhen(tx.createdAt)}</Table.Cell>
                          <Table.Cell>{tx.currency}</Table.Cell>
                          <Table.Cell>
                            {tx.delta > 0 ? `+${tx.delta}` : tx.delta}
                          </Table.Cell>
                          <Table.Cell>{tx.balanceAfter}</Table.Cell>
                          <Table.Cell>
                            {tx.reason}
                            {tx.refId ? ` · ${tx.refId}` : ""}
                          </Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table.Root>
                </Box>
              )}
            </Card>
          ) : null}

          <Card>
            <Flex align="center" gap="2" mb="3">
              <Users {...iconProps} />
              <Heading as="h2" size="4">
                Player accounts
              </Heading>
            </Flex>
            <Grid columns={{ initial: "1", sm: "3" }} gap="2" mb="3">
              <label>
                <Text as="div" mb="1" size="1" weight="medium" color="gray">
                  Search
                </Text>
                <TextField.Root
                  disabled={busy}
                  placeholder="email, username, display name"
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    setOffset(0);
                    setQuery(searchInput);
                  }}
                />
              </label>
              <label>
                <Text as="div" mb="1" size="1" weight="medium" color="gray">
                  Status
                </Text>
                <Select.Root
                  value={statusFilter || "all"}
                  onValueChange={(value) => {
                    setOffset(0);
                    setStatusFilter(value === "all" ? "" : (value as UserStatus));
                  }}
                >
                  <Select.Trigger />
                  <Select.Content>
                    <Select.Item value="all">All</Select.Item>
                    <Select.Item value="active">Active</Select.Item>
                    <Select.Item value="banned">Banned</Select.Item>
                    <Select.Item value="deleted">Deleted</Select.Item>
                  </Select.Content>
                </Select.Root>
              </label>
              <Flex align="end" gap="2" wrap="wrap">
                <Button
                  color="gray"
                  disabled={busy}
                  variant="soft"
                  onClick={() => {
                    setOffset(0);
                    setQuery(searchInput);
                  }}
                >
                  Search
                </Button>
                <Text size="2" color="gray">
                  Showing {pageStart}–{pageEnd} of {total}
                </Text>
              </Flex>
            </Grid>

            <Box style={{ overflow: "auto", maxHeight: 360 }}>
              <Table.Root size="2" variant="surface">
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeaderCell>Email</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Name</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Status</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Wallet</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Last seen</Table.ColumnHeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {users.length === 0 ? (
                    <Table.Row>
                      <Table.Cell colSpan={5}>
                        <Text color="gray" size="2">
                          No users found.
                        </Text>
                      </Table.Cell>
                    </Table.Row>
                  ) : (
                    users.map((user) => (
                      <Table.Row
                        key={user.id}
                        style={{
                          cursor: "pointer",
                          background:
                            selectedId === user.id ? "var(--accent-a3)" : undefined,
                        }}
                        onClick={() => selectUser(user)}
                      >
                        <Table.Cell>
                          <Button
                            type="button"
                            variant="ghost"
                            style={{
                              display: "block",
                              width: "100%",
                              height: "auto",
                              padding: 0,
                              textAlign: "left",
                            }}
                            onClick={(event) => {
                              event.stopPropagation();
                              selectUser(user);
                            }}
                          >
                            <Flex direction="column" gap="1" align="start">
                              <Text size="2" weight="medium">
                                {user.email}
                              </Text>
                              <Text size="1" color="gray">
                                {user.provider}
                                {user.emailVerified ? " · verified" : " · unverified"}
                              </Text>
                            </Flex>
                          </Button>
                        </Table.Cell>
                        <Table.Cell>
                          <Text size="2">
                            {user.displayName || user.username || "—"}
                          </Text>
                        </Table.Cell>
                        <Table.Cell>
                          <Badge color={statusColor(user.status)} variant="soft">
                            {user.status}
                          </Badge>
                        </Table.Cell>
                        <Table.Cell>
                          <Text size="2">
                            {user.wallet.diamonds}◆ · {user.wallet.coins}●
                          </Text>
                        </Table.Cell>
                        <Table.Cell>
                          <Text size="2">{formatWhen(user.lastSeenAt)}</Text>
                        </Table.Cell>
                      </Table.Row>
                    ))
                  )}
                </Table.Body>
              </Table.Root>
            </Box>

            <Flex justify="between" mt="3" wrap="wrap" gap="2">
              <Button
                color="gray"
                disabled={busy || offset === 0}
                variant="soft"
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                Previous
              </Button>
              <Button
                color="gray"
                disabled={busy || offset + PAGE_SIZE >= total}
                variant="soft"
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next
              </Button>
            </Flex>
          </Card>
        </Flex>
      </Container>
    </main>
  );
}
