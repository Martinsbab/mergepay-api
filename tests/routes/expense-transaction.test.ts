/**
 * Atomicity of group expense creation (#537).
 *
 * `POST /groups/:id/expenses` writes three things: the expense row, its
 * participant split rows, and the `expense.create` audit log. The route runs
 * all three inside one interactive `prisma.$transaction`, so a failure in any
 * one of them must leave no trace of the others behind.
 *
 * Prisma is mocked per CONTRIBUTING.md (tests never touch a real database),
 * with a transactional fake: `$transaction` snapshots an in-memory store
 * before running the callback and restores it if the callback throws — the
 * same all-or-nothing guarantee Prisma gives against Postgres. A regression
 * to sequential, non-transactional writes would leave the staged expense row
 * behind and fail the rollback assertions below.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  interface Store {
    expenses: any[];
    shares: any[];
    auditLogs: any[];
  }

  const store: Store = { expenses: [], shares: [], auditLogs: [] };

  /**
   * Test toggles. Split/audit failures are injected *after* the expense row
   * has been staged, which is exactly the partial-write scenario a missing
   * transaction would leave committed.
   */
  const flags = { failSplitInsertion: false, failAuditLog: false };

  const model = () => ({
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(async () => []),
    count: vi.fn(async () => 0),
  });

  const prisma: any = {
    expense: model(),
    groupMember: model(),
    group: model(),
    user: model(),
    auditLog: model(),
    $transaction: vi.fn(),
  };

  return { prisma, store, flags };
});

vi.mock("../../src/db", () => ({ prisma: h.prisma }));

import { buildApp } from "../../src/app";
import { signToken } from "../../src/plugins/auth";

let app: Awaited<ReturnType<typeof buildApp>>;
const prisma = h.prisma;

const GROUP_ID = "group_1";
const USER_ID = "user_1";
const OTHER_ID = "user_2";
const PUBLIC_KEY = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function userRow(id: string) {
  return {
    id,
    stellarPublicKey: PUBLIC_KEY,
    displayName: `User ${id}`,
    avatarUrl: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function authHeader(userId = USER_ID) {
  return {
    authorization: `Bearer ${signToken({ id: userId, stellarPublicKey: PUBLIC_KEY })}`,
  };
}

const createPayload = {
  title: "Dinner",
  amount: "100",
  assetCode: "XLM",
  splitType: "equal",
  shares: [{ userId: USER_ID }, { userId: OTHER_ID }],
};

async function createExpense() {
  return app.inject({
    method: "POST",
    url: `/groups/${GROUP_ID}/expenses`,
    headers: authHeader(),
    payload: createPayload,
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  h.store.expenses = [];
  h.store.shares = [];
  h.store.auditLogs = [];
  h.flags.failSplitInsertion = false;
  h.flags.failAuditLog = false;

  // All-or-nothing transaction: snapshot before the callback, restore on
  // throw. Callbacks receive the same client the route would get as `tx`.
  h.prisma.$transaction.mockImplementation(async (arg: any) => {
    if (typeof arg !== "function") return Promise.all(arg);
    const snapshot = structuredClone({ ...h.store });
    try {
      return await arg(h.prisma);
    } catch (err) {
      h.store.expenses = snapshot.expenses;
      h.store.shares = snapshot.shares;
      h.store.auditLogs = snapshot.auditLogs;
      throw err;
    }
  });

  // Models the two writes Prisma performs for `expense.create` with a nested
  // `shares.create`: stage the expense row, then insert the split rows.
  h.prisma.expense.create.mockImplementation(async ({ data }: any) => {
    const expense = {
      id: "exp_tx_1",
      createdAt: new Date("2026-02-01T00:00:00Z"),
      payer: userRow(data.payerUserId),
      ...data,
      shares: [] as any[],
    };
    h.store.expenses.push({ id: expense.id, data });

    if (h.flags.failSplitInsertion) {
      throw new Error("simulated participant split insertion failure");
    }

    expense.shares = (data.shares?.create ?? []).map((s: any, i: number) => ({
      id: `share_${i + 1}`,
      expenseId: expense.id,
      ...s,
      user: userRow(s.userId),
    }));
    h.store.shares.push(...expense.shares);
    return expense;
  });

  h.prisma.auditLog.create.mockImplementation(async ({ data }: any) => {
    if (h.flags.failAuditLog) {
      throw new Error("simulated audit log failure");
    }
    h.store.auditLogs.push(data);
    return { id: "audit_1", ...data };
  });

  h.prisma.groupMember.findUnique.mockResolvedValue({
    groupId: GROUP_ID,
    userId: USER_ID,
    role: "member",
  });
  h.prisma.groupMember.findMany.mockResolvedValue([
    { userId: USER_ID, user: userRow(USER_ID) },
    { userId: OTHER_ID, user: userRow(OTHER_ID) },
  ]);

  app = await buildApp();
});

describe("POST /groups/:id/expenses — transaction atomicity", () => {
  it("commits the expense, its participant splits, and the audit log together on success", async () => {
    const res = await createExpense();

    expect(res.statusCode).toBe(200);
    expect(res.json().expense.title).toBe("Dinner");

    // All three writes ran inside one interactive transaction.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction.mock.calls[0]?.[0]).toBeTypeOf("function");

    expect(h.store.expenses).toHaveLength(1);
    expect(h.store.shares).toHaveLength(2);
    // The payer's share settles at creation; the other participant owes.
    expect(h.store.shares.map((s: any) => s.status)).toEqual([
      "settled",
      "pending",
    ]);

    expect(h.store.auditLogs).toHaveLength(1);
    expect(h.store.auditLogs[0]).toMatchObject({
      userId: USER_ID,
      groupId: GROUP_ID,
      action: "expense.create",
      entityType: "expense",
      entityId: "exp_tx_1",
    });
  });

  it("rolls back the expense and leaves no partial rows when participant split insertion fails", async () => {
    h.flags.failSplitInsertion = true;

    const res = await createExpense();

    // The transaction rejects and the request fails...
    expect(res.statusCode).toBe(500);
    expect(res.json().code).toBe("INTERNAL_ERROR");
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);

    // ...and nothing from the failed operation remains: no orphaned expense
    // record, no partial split records, no audit log.
    expect(h.store.expenses).toHaveLength(0);
    expect(h.store.shares).toHaveLength(0);
    expect(h.store.auditLogs).toHaveLength(0);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("rolls back the expense and its splits when the audit log write fails", async () => {
    h.flags.failAuditLog = true;

    const res = await createExpense();

    expect(res.statusCode).toBe(500);
    expect(res.json().code).toBe("INTERNAL_ERROR");

    // The audit write happens after the expense and its splits inside the
    // same transaction, so its failure must undo them as well.
    expect(h.store.expenses).toHaveLength(0);
    expect(h.store.shares).toHaveLength(0);
    expect(h.store.auditLogs).toHaveLength(0);
  });

  it("never runs the creation transaction when membership is missing", async () => {
    h.prisma.groupMember.findUnique.mockResolvedValue(null);
    h.prisma.group.findUnique.mockResolvedValue({ id: GROUP_ID });

    const res = await createExpense();

    expect(res.statusCode).toBe(403);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(h.store.expenses).toHaveLength(0);
  });
});
