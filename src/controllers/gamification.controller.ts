import type { Request, Response, NextFunction } from "express";
import { HttpStatusCode } from "axios";
import { Types } from "mongoose";
import { models } from "../models";

export async function getUserPoints(
  req: Request,
  res: Response,
  _next: NextFunction,
): Promise<void> {
  try {
    const { userId } = req.params as { userId: string };
    if (!userId || !Types.ObjectId.isValid(userId)) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid parameter. A valid userId is required." });
      return;
    }

    const user = await models.users.findById(userId).lean();
    if (!user) {
      res.status(HttpStatusCode.NotFound).send({ message: "User not found." });
      return;
    }

    const points = Number(user.points || 0);
    res.setHeader("X-User-Points", String(points));
    res.status(HttpStatusCode.Ok).send({ message: "User points retrieved successfully.", points });
    return;
  } catch (error: any) {
    console.error("Error fetching user points", error);
    res.status(error?.status || HttpStatusCode.InternalServerError).send({ message: error?.message || "Internal server error." });
    return;
  }
}

