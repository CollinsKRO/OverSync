import { Router } from "express";
import { z } from "zod";
import type { OrderRow, OrderSnapshot } from "../../persistence/orders-repo.js";
import { announceSchema, OrderService, OrderValidationError } from "../../services/order-service.js";
import { isTransitionRejection } from "../../services/order-service.js";
import { encodeCursor, decodeCursor } from "./cursor-utils.js";
import { evaluateRefundEligibility } from "../../utils/timelock-validator.js";

function orderValidationResponse(err: OrderValidationError): { status: number; body: Record<string, unknown> } {
  // A refused lifecycle edge is a conflict with the stored order, not a bad
  // request: answer 409 with the stable failure code so clients can tell an
  // illegal transition apart from a malformed payload (issue #252).
  if (isTransitionRejection(err)) {
    return {
      status: 409,
      body: {
        error: "illegal_transition",
        code: err.code,
        from: err.from,
        to: err.to,
        action: err.action,
        message: err.message
      }
    };
  }
  if (err.code === "TIMELOCKS_REVERSED" || err.code === "GAP_TOO_SMALL") {
    return { status: 400, body: { error: "timelock_ordering_invalid", code: err.code } };
  }
  return { status: 400, body: { error: "order_validation_error", message: err.message } };
}


function serialiseOrder(order: OrderRow | null) {
  if (!order) return null;
  return {
    id: order.publicId,
    direction: order.direction,
    status: order.status,
    hashlock: order.hashlock,
    src: {
      chain: order.srcChain,
      address: order.srcAddress,
      asset: order.srcAsset,
      amount: order.srcAmount,
      safetyDeposit: order.srcSafetyDeposit,
      orderId: order.srcOrderId,
      lockTx: order.srcLockTx,
      lockBlock: order.srcLockBlock,
      timelock: order.srcTimelock
    },
    dst: {
      chain: order.dstChain,
      address: order.dstAddress,
      asset: order.dstAsset,
      amount: order.dstAmount,
      orderId: order.dstOrderId,
      lockTx: order.dstLockTx,
      lockBlock: order.dstLockBlock,
      timelock: order.dstTimelock
    },
    secret: {
      revealed: order.preimage !== null,
      preimage: order.preimage,
      revealedTx: order.secretRevealedTx
    },
    resolver: order.resolverAddress,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt
  };
}

export function ordersRoutes(orders: OrderService): Router {
  const router = Router();

  router.post("/orders/announce", async (req, res, next) => {
    try {
      const parsed = announceSchema.parse(req.body);
      const order = await orders.announce(parsed);
      res.status(201).json(serialiseOrder(order));
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: "validation_error", details: err.errors });
        return;
      }
      if (err instanceof OrderValidationError) {
        const { status, body } = orderValidationResponse(err);
        res.status(status).json(body);
        return;
      }
      next(err);
    }
  });

  // IMPORTANT: Specific routes must come BEFORE parameterized routes
  router.get("/orders/history", async (req, res, next) => {
    const address = (req.query.address as string | undefined) ?? "";
    if (!address) {
      res.status(400).json({ error: "address_required" });
      return;
    }

    // Validate and parse limit
    const limitStr = req.query.limit as string | undefined;
    const limit = limitStr ? Number(limitStr) : 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      res.status(400).json({ error: "invalid_limit", message: "limit must be an integer between 1 and 200" });
      return;
    }

    // Validate and decode cursor (optional)
    let offset = 0;
    const cursorStr = req.query.cursor as string | undefined;
    if (cursorStr) {
      const decoded = decodeCursor(cursorStr);
      if (!decoded) {
        res.status(400).json({ error: "invalid_cursor", message: "cursor is malformed or expired" });
        return;
      }
      offset = decoded.offset;
    }

    try {
      // Fetch limit + 1 to detect if more rows exist
      const list = await orders.history(address, limit + 1, offset);
      const hasMore = list.length > limit;
      const rows = hasMore ? list.slice(0, limit) : list;

      // Generate next cursor if there are more rows
      let nextCursor: string | null = null;
      if (hasMore && rows.length > 0) {
        const lastRow = rows[rows.length - 1];
        if (lastRow) {
          nextCursor = encodeCursor({ offset: offset + limit, createdAt: lastRow.createdAt });
        }
      }

      res.json({
        transactions: rows.map((o) => serialiseOrder(o)).filter(Boolean),
        pagination: {
          limit,
          cursor: cursorStr ?? null,
          nextCursor,
          hasMore
        }
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/orders/snapshot", async (_req, res, next) => {
    try {
      const snapshots = await orders.getSnapshots();
      res.json({ snapshots });
    } catch (err) {
      next(err);
    }
  });

  router.get("/orders/:id/transitions", async (req, res, next) => {
    const id = req.params.id;
    try {
      const order = await orders.get(id);
      if (!order) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const transitions = await orders.getTransitions(id);
      // Refused attempts are part of the audit trail but are reported
      // separately: they never changed the order status.
      const rejectedTransitions = await orders.getRejectedTransitions(id);
      res.json({ transitions, rejectedTransitions });
    } catch (err) {
      next(err);
    }
  });

  // Refused transitions for an order, with their stable failure codes.
  router.get("/orders/:id/rejected-transitions", async (req, res, next) => {
    const id = req.params.id;
    try {
      const order = await orders.get(id);
      if (!order) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const rejectedTransitions = await orders.getRejectedTransitions(id);
      res.json({ rejectedTransitions, status: order.status });
    } catch (err) {
      next(err);
    }
  });

  router.get("/orders/:id/refund-eligibility", async (req, res, next) => {
    try {
      const order = await orders.get(req.params.id);
      if (!order) {
        res.status(404).json({ error: "not_found" });
        return;
      }

      const timelocks = {
        ethereum: order.srcChain === "ethereum" ? order.srcTimelock : order.dstTimelock,
        stellar: order.srcChain === "stellar" ? order.srcTimelock : order.dstTimelock
      };
      res.json(evaluateRefundEligibility(timelocks, Math.floor(Date.now() / 1000)));
    } catch (err) {
      next(err);
    }
  });

  // Parameterized routes come AFTER specific routes
router.get("/orders/:id", async (req, res, next) => {
    const id = req.params.id;
    try {
      const order = await orders.get(id);
      if (!order) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json(serialiseOrder(order));
    } catch (err) {
      next(err);
    }
  });

  const lockSchema = z.object({
    orderId: z.string().min(1),
    txHash: z.string().min(1),
    blockNumber: z.coerce.number().int().nonnegative(),
    timelock: z.coerce.number().int().nonnegative()
  });

  router.post("/orders/:id/src-locked", async (req, res, next) => {
    try {
      const body = lockSchema.parse(req.body);
      await orders.recordSrcLock({ publicId: req.params.id, ...body });
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: "validation_error", details: err.errors });
        return;
      }
      if (err instanceof OrderValidationError) {
        const { status, body } = orderValidationResponse(err);
        res.status(status).json(body);
        return;
      }
      next(err);
    }
  });

  router.post("/orders/:id/dst-locked", async (req, res, next) => {
    try {
      const body = lockSchema.extend({ resolver: z.string().nullable().optional() }).parse(req.body);
      await orders.recordDstLock({
        publicId: req.params.id,
        orderId: body.orderId,
        txHash: body.txHash,
        blockNumber: body.blockNumber,
        timelock: body.timelock,
        resolver: body.resolver ?? null
      });
      res.json({ ok: true });
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: "validation_error", details: err.errors });
        return;
      }
      if (err instanceof OrderValidationError) {
        const { status, body } = orderValidationResponse(err);
        res.status(status).json(body);
        return;
      }
      next(err);
    }
  });

  return router;
}