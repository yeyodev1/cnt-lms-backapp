import type { Request, Response, NextFunction } from "express";
import { HttpStatusCode } from "axios";
import { models } from "../models";
import { Types } from "mongoose";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { TeachableUsersService } from "../services/teachable";
import { EmailService } from "../services/email.service";
import type { IUser, CourseAccess } from "../types/user";
import type { CreateUserBodyParam, EnrollUserBodyParam } from "@api/teachable/types";
import { EnrollmentService } from "../services/enrollment.service";

type CreateUserRequestBody = {
  name?: string;
  email?: string;
  password?: string;
  courseId?: string | number | null;
};

type TeachableCreateUserResponse = {
  data?: { id?: number; user?: { id?: number } };
};

function extractTeachableUserId(resp: unknown): number | undefined {
  const r = resp as TeachableCreateUserResponse | undefined;
  const id = r?.data?.id ?? r?.data?.user?.id;
  return typeof id === "number" ? id : undefined;
}

export async function createUser(
  req: Request,
  res: Response,
  _next: NextFunction,
): Promise<void> {
  try {
    const { name, email, password, courseId } = (req.body || {}) as CreateUserRequestBody;

    if (!name || !email || !password) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid payload. Name, email and password are required." });
      return;
    }

    const existing = await models.users.findOne({ email }).lean<IUser>();
    if (existing) {
      res.status(HttpStatusCode.Conflict).send({ message: "User already exists." });
      return;
    }

    const user = await models.users.create({ name, email, password });

    const teachableService = new TeachableUsersService();
    const createBody: CreateUserBodyParam = { name, email, password };
    const teachableRes = await teachableService.createUser(createBody);
    const teachableUserId = extractTeachableUserId(teachableRes);

    if (typeof teachableUserId === "number") {
      user.teachableUserId = teachableUserId;
      await user.save();

      const requestedCourseId = courseId;
      const defaultCourseId = process.env.TEACHABLE_DEFAULT_COURSE_ID;
      const courseIdValue = requestedCourseId ?? defaultCourseId;

      if (courseIdValue !== undefined && courseIdValue !== null && String(courseIdValue).trim() !== "") {
        const courseIdNumber = Number(courseIdValue);
        if (!Number.isNaN(courseIdNumber) && courseIdNumber > 0) {
          const enrollBody: EnrollUserBodyParam = { user_id: teachableUserId, course_id: courseIdNumber };
          await teachableService.enrollUser(enrollBody);
          user.courses.push({ teachableCourseId: courseIdNumber, status: "active", enrolledAt: new Date(), expiresAt: null, courseRef: null });
          await user.save();
        }
      }
    }

    const safeUser = {
      _id: user._id,
      name: user.name,
      email: user.email,
      teachableUserId: user.teachableUserId,
      gender: user.gender,
      genderOther: user.genderOther,
      dateOfBirth: user.dateOfBirth,
      heardAboutUs: user.heardAboutUs,
      heardAboutUsOther: user.heardAboutUsOther,
      courses: user.courses,
      careers: user.careers,
      payments: user.payments,

      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      onboardingCompleted: user.onboardingCompleted,
    };

    res.status(HttpStatusCode.Created).send({ message: "User created successfully.", user: safeUser });
    return;
  } catch (error) {
    console.error("Error creating user", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "Internal server error." });
    return;
  }
}


export async function deleteUser(
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

    const user = await models.users.findById(userId);
    if (!user) {
      res.status(HttpStatusCode.NotFound).send({ message: "User not found." });
      return;
    }

    // Delete all related data in parallel
    await Promise.all([
      models.transactions.deleteMany({ user: userId }),
      models.quizSubmissions.deleteMany({ userRef: userId }),
      models.comments.deleteMany({ user: userId }),
      models.certificates.deleteMany({ userRef: userId }),
      // Also remove user from likes in comments? Maybe too heavy, but let's stick to main entities.
    ]);

    // Finally delete the user
    await models.users.findByIdAndDelete(userId);

    res.status(HttpStatusCode.Ok).send({ message: "User and all related data deleted successfully." });
    return;
  } catch (error) {
    console.error("Error deleting user", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "Internal server error." });
    return;
  }
}

export async function getUsers(
  req: Request,
  res: Response,
  _next: NextFunction,
): Promise<void> {
  try {
    const { page = 1, limit = 10, search } = req.query as { page?: string; limit?: string; search?: string };
    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.max(1, Math.min(100, Number(limit) || 10));
    const skip = (pageNum - 1) * limitNum;

    const query: any = {};
    if (search) {
      const searchRegex = { $regex: search, $options: "i" };
      query.$or = [
        { name: searchRegex },
        { email: searchRegex },
      ];
    }

    const [users, total] = await Promise.all([
      models.users
        .find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean<IUser[]>(),
      models.users.countDocuments(query),
    ]);

    const usersWithStats = users.map((user) => {
      const approvedCourses = user.courses.filter((c) => c.completedAt).length;
      const approvedCareers = user.careers.filter((c) => c.completedAt).length;

      return {
        _id: user._id,
        name: user.name,
        email: user.email,
        teachableUserId: user.teachableUserId,
        points: user.points,
        gender: user.gender,
        dateOfBirth: user.dateOfBirth,
        courses: user.courses,
        careers: user.careers,
        approvedCoursesCount: approvedCourses,
        approvedCareersCount: approvedCareers,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      };
    });

    res.status(HttpStatusCode.Ok).send({
      message: "Users retrieved successfully.",
      data: usersWithStats,
      meta: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum),
      },
    });
    return;
  } catch (error) {
    console.error("Error fetching users", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "Internal server error." });
    return;
  }
}

export async function getUserById(
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

    const user = await models.users.findById(userId).lean<IUser>();
    if (!user) {
      res.status(HttpStatusCode.NotFound).send({ message: "User not found." });
      return;
    }

    const safeUser = {
      _id: user._id,
      name: user.name,
      email: user.email,
      teachableUserId: user.teachableUserId,
      gender: user.gender,
      genderOther: user.genderOther,
      dateOfBirth: user.dateOfBirth,
      heardAboutUs: user.heardAboutUs,
      heardAboutUsOther: user.heardAboutUsOther,
      points: user.points,
      courses: user.courses,
      careers: user.careers,
      payments: user.payments,
      transactions: user.transactions,
      accountType: user.accountType || "free",
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      onboardingCompleted: user.onboardingCompleted,
    };

    res.status(HttpStatusCode.Ok).send({ message: "User retrieved successfully.", user: safeUser });
    return;
  } catch (error) {
    console.error("Error fetching user", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "Internal server error." });
    return;
  }
}

export async function checkUserByEmail(
  req: Request,
  res: Response,
  _next: NextFunction,
): Promise<void> {
  try {
    const q = (req.query || {}) as Record<string, unknown>;
    const emailParam = q.email;
    const value = Array.isArray(emailParam)
      ? (emailParam[0] ?? "").trim()
      : typeof emailParam === "string"
        ? emailParam.trim()
        : "";
    if (!value) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid parameter. A valid email is required." });
      return;
    }

    const user = await models.users.findOne({ email: value }).lean<IUser>();
    if (!user) {
      res.status(HttpStatusCode.Ok).send({ message: "User not found.", exists: false });
      return;
    }

    // Check if user has a paid account type (anything other than "free")
    // If they have a paid account (premium, student, founder), we pretend they don't exist 
    // to allow the frontend to proceed with a purchase/registration flow without blocking.

    const accountType = user.accountType || "free";

    // If account type is NOT free, we return exists: false to allow the process to continue
    if (accountType !== "free") {
      res.status(HttpStatusCode.Ok).send({ message: "User not found (masked).", exists: false });
      return;
    }

    const safeUser = {
      _id: user._id,
      email: user.email,
      teachableUserId: user.teachableUserId,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      accountType,
      onboardingCompleted: user.onboardingCompleted,
    };

    res.status(HttpStatusCode.Ok).send({ message: "User exists.", exists: true, user: safeUser });
    return;
  } catch (error) {
    console.error("Error checking user email", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "Internal server error." });
    return;
  }
}

export async function loginUser(
  req: Request,
  res: Response,
  _next: NextFunction,
): Promise<void> {
  try {
    const { email, password } = (req.body || {}) as { email?: string; password?: string };

    if (!email || !password) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid payload. Email and password are required." });
      return;
    }

    const user = await models.users.findOne({ email });
    if (!user) {
      res.status(HttpStatusCode.Unauthorized).send({ message: "Invalid credentials." });
      return;
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      res.status(HttpStatusCode.Unauthorized).send({ message: "Invalid credentials." });
      return;
    }

    const secret = process.env.JWT_SECRET?.trim();
    if (!secret) {
      console.error("Missing JWT_SECRET env var");
      res.status(HttpStatusCode.InternalServerError).send({ message: "Internal server error." });
      return;
    }

    const token = jwt.sign(
      { sub: user._id.toString(), email: user.email },
      secret,
      { expiresIn: "7d" },
    );

    const safeUser = {
      _id: user._id,
      name: user.name,
      email: user.email,
      teachableUserId: user.teachableUserId,
      gender: user.gender,
      genderOther: user.genderOther,
      dateOfBirth: user.dateOfBirth,
      heardAboutUs: user.heardAboutUs,
      heardAboutUsOther: user.heardAboutUsOther,
      courses: user.courses,
      careers: user.careers,
      payments: user.payments,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      onboardingCompleted: user.onboardingCompleted,
    };

    // Auto-enroll founder if needed
    if (user.accountType === "founder") {
      const enrollmentService = new EnrollmentService();
      enrollmentService.enrollUserInAllAvailableCourses(user._id.toString()).catch(err => {
        console.error("Error auto-enrolling founder on login:", err);
      });
    }

    res.status(HttpStatusCode.Ok).send({ message: "Login successful.", token, user: safeUser });
    return;
  } catch (error) {
    console.error("Error logging in user", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "Internal server error." });
    return;
  }
}

function randomPassword(length = 32): string {
  // Use URL-safe characters to avoid issues with query params
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < length; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

import { PaymentService, type PaymentPayload } from "../services/payment.service";

export async function registerFromPayment(
  req: Request,
  res: Response,
  _next: NextFunction,
): Promise<void> {
  try {
    const payload = (req.body || {}) as PaymentPayload;
    const paymentService = new PaymentService();

    // Delegate logic to service
    // Service throws Error if validation fails
    let result;
    try {
      result = await paymentService.processPaymentRegistration(payload);
    } catch (err: any) {
      if (err.message && err.message.includes("Invalid payload")) {
        res.status(HttpStatusCode.BadRequest).send({ message: err.message });
        return;
      }
      throw err;
    }

    const { user, isNew } = result;

    const safeUser = {
      _id: user._id,
      name: user.name,
      email: user.email,
      teachableUserId: user.teachableUserId,
      gender: user.gender,
      genderOther: user.genderOther,
      dateOfBirth: user.dateOfBirth,
      heardAboutUs: user.heardAboutUs,
      heardAboutUsOther: user.heardAboutUsOther,
      courses: user.courses,
      careers: user.careers,
      payments: user.payments,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      accountType: user.accountType || "free",
      onboardingCompleted: user.onboardingCompleted,
    };

    // Auto-enroll founder if needed
    if (user.accountType === "founder") {
      const enrollmentService = new EnrollmentService();
      enrollmentService.enrollUserInAllAvailableCourses(user._id.toString()).catch(err => {
        console.error("Error auto-enrolling founder on registration:", err);
      });
    }

    if (isNew) {
      res.status(HttpStatusCode.Created).send({ message: "User created and email sent successfully.", user: safeUser });
    } else {
      res.status(HttpStatusCode.Ok).send({ message: "User updated to founder successfully.", user: safeUser });
    }
    return;
  } catch (error) {
    console.error("Error creating/updating user from payment", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "Internal server error." });
    return;
  }
}

export async function updateUser(
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

    const allowedGenders = ["male", "female", "prefer_not_to_say", "other"] as const;
    const allowedHeard = [
      "social_media_ad",
      "friend_colleague",
      "search_engine",
      "online_article_blog",
      "youtube_video",
      "podcast",
      "event_webinar",
      "email_campaign",
      "teachable_marketplace",
      "other",
    ] as const;

    const { name, email, gender, genderOther, dateOfBirth, heardAboutUs, heardAboutUsOther } = (req.body || {}) as {
      name?: string;
      email?: string;
      gender?: string;
      genderOther?: string | null;
      dateOfBirth?: string | Date | null;
      heardAboutUs?: string;
      heardAboutUsOther?: string | null;
    };

    const user = await models.users.findById(userId);
    if (!user) {
      res.status(HttpStatusCode.NotFound).send({ message: "User not found." });
      return;
    }

    if (typeof name === "string" && name.trim() !== "") {
      user.name = name.trim();
    }

    if (typeof email === "string" && email.trim() !== "" && email.trim() !== user.email) {
      const conflict = await models.users.findOne({ email: email.trim(), _id: { $ne: user._id } }).lean<IUser>();
      if (conflict) {
        res.status(HttpStatusCode.Conflict).send({ message: "Email already in use." });
        return;
      }
      user.email = email.trim();
    }

    if (typeof gender === "string") {
      const g = gender.trim().toLowerCase();
      if (!allowedGenders.includes(g as typeof allowedGenders[number])) {
        res.status(HttpStatusCode.BadRequest).send({ message: "Invalid payload. Gender value is not allowed." });
        return;
      }
      user.gender = g as typeof allowedGenders[number];
      user.genderOther = g === "other" && typeof genderOther === "string" && genderOther.trim() !== "" ? genderOther.trim() : null;
    } else if (Object.prototype.hasOwnProperty.call((req.body || {}), "genderOther")) {
      user.genderOther = typeof genderOther === "string" && genderOther.trim() !== "" ? genderOther.trim() : null;
    }

    if (Object.prototype.hasOwnProperty.call((req.body || {}), "dateOfBirth")) {
      if (dateOfBirth === null || dateOfBirth === "") {
        user.dateOfBirth = null;
      } else {
        const d = new Date(dateOfBirth as string | number | Date);
        if (Number.isNaN(d.getTime())) {
          res.status(HttpStatusCode.BadRequest).send({ message: "Invalid payload. dateOfBirth must be a valid date." });
          return;
        }
        user.dateOfBirth = d;
      }
    }

    if (typeof heardAboutUs === "string") {
      const h = heardAboutUs.trim().toLowerCase();
      if (!allowedHeard.includes(h as typeof allowedHeard[number])) {
        res.status(HttpStatusCode.BadRequest).send({ message: "Invalid payload. heardAboutUs value is not allowed." });
        return;
      }
      user.heardAboutUs = h as typeof allowedHeard[number];
      user.heardAboutUsOther = h === "other" && typeof heardAboutUsOther === "string" && heardAboutUsOther.trim() !== "" ? heardAboutUsOther.trim() : null;
    } else if (Object.prototype.hasOwnProperty.call((req.body || {}), "heardAboutUsOther")) {
      user.heardAboutUsOther = typeof heardAboutUsOther === "string" && heardAboutUsOther.trim() !== "" ? heardAboutUsOther.trim() : null;
    }

    // Allow updating accountType (Admin feature ideally, but open for now as requested)
    if (Object.prototype.hasOwnProperty.call((req.body || {}), "accountType")) {
      const { accountType } = req.body as { accountType?: string };
      if (accountType && ["free", "premium", "student", "founder"].includes(accountType)) {
        user.accountType = accountType as IUser["accountType"];
      }
    }

    await user.save();

    const safeUser = {
      _id: user._id,
      name: user.name,
      email: user.email,
      teachableUserId: user.teachableUserId,
      gender: user.gender,
      genderOther: user.genderOther,
      dateOfBirth: user.dateOfBirth,
      heardAboutUs: user.heardAboutUs,
      heardAboutUsOther: user.heardAboutUsOther,
      points: user.points,
      courses: user.courses,
      careers: user.careers,
      payments: user.payments,
      transactions: user.transactions,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      onboardingCompleted: user.onboardingCompleted,
    };

    res.status(HttpStatusCode.Ok).send({ message: "User updated successfully.", user: safeUser });
    return;
  } catch (error) {
    console.error("Error updating user", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "Internal server error." });
    return;
  }
}

export async function grantManualAccess(
  req: Request,
  res: Response,
  _next: NextFunction,
): Promise<void> {
  try {
    const { name, email, courseIds: requestedCourseIds } = (req.body || {}) as {
      name?: string;
      email?: string;
      courseIds?: Array<number | string>;
    };

    if (!name || !email) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid payload. Name and email are required." });
      return;
    }

    let user = await models.users.findOne({ email }).lean<IUser>();
    let password = "";
    let isNewUser = false;

    if (!user) {
      isNewUser = true;
      password = randomPassword(12);
      // Create user
      const newUser = await models.users.create({ name, email, password });
      user = newUser.toObject();
    }

    // Always ensure we have a teachable user
    const teachableService = new TeachableUsersService();
    if (!user!.teachableUserId) {
      // Create in Teachable if missing
      // If user existed but no teachableId, we need a password for teachable creation?
      // Teachable API requires password. If existing user, we don't have their password.
      // We might generate a temp one if we strictly need to create it.
      // But for now, let's assume if it's new user we have password.
      const pwdToUse = password || randomPassword(12);
      const createBody: CreateUserBodyParam = { name, email, password: pwdToUse };
      const teachableRes = await teachableService.createUser(createBody);
      const teachableUserId = extractTeachableUserId(teachableRes);

      if (teachableUserId) {
        await models.users.updateOne({ _id: user!._id }, { teachableUserId });
        user!.teachableUserId = teachableUserId;
      }
    }

    // Enrollment Logic
    if (user!.teachableUserId) {
      const allCourseIds: number[] = [];
      const mandatoryCourseId = 2916425;
      allCourseIds.push(mandatoryCourseId);

      // Add requested courses
      if (Array.isArray(requestedCourseIds)) {
        requestedCourseIds.forEach(cid => {
          const n = Number(cid);
          if (Number.isFinite(n) && n > 0) allCourseIds.push(n);
        });
      }

      // Add env default courses
      const envCourseIdsRaw = process.env.TEACHABLE_DEFAULT_COURSE_IDS;
      if (envCourseIdsRaw && envCourseIdsRaw.trim() !== "") {
        const envIds = envCourseIdsRaw
          .split(",")
          .map((s) => Number(s.trim()))
          .filter((n: number) => Number.isFinite(n) && n > 0);
        allCourseIds.push(...envIds);
      }

      const envSingle = process.env.TEACHABLE_DEFAULT_COURSE_ID;
      if (envSingle && String(envSingle).trim() !== "") {
        const single = Number(envSingle);
        if (Number.isFinite(single) && single > 0) allCourseIds.push(single);
      }

      // Prioritize mandatory and unique
      // Note: "slice(0, 3)" is in the payment flow. The user said "todos los cursos". 
      // If we want *all* defaults + requested, maybe we shouldn't slice if it's manual access?
      // But to be "like payment flow", I will keep the logic but maybe expand the limit if requested explicitly?
      // Let's stick to the exact logic of registerFromPayment for consistency, but if they requested specific IDs, we ensure they are in.
      const uniqueCourseIds = Array.from(new Set(allCourseIds));
      // If I slice, I might cut off requested ones.
      // I will slice ONLY if no specific ids were requested, or ensure requested are first?
      // The payment flow prioritizes mandatory then others.
      // Let's just enroll in ALL unique determined courses to be safe for "manual access".
      // Remove slice for manual access to ensure "todos" really means all intended.

      const coursesToEnroll = uniqueCourseIds; // No slice for manual override

      // Fetch fresh user document to update
      const userDoc = await models.users.findById(user!._id);
      if (!userDoc) throw new Error("User not found after creation");

      for (const cid of coursesToEnroll) {
        let enrolledRemotely = false;
        try {
          const body: EnrollUserBodyParam = { user_id: user!.teachableUserId, course_id: cid };
          await teachableService.enrollUser(body);
          enrolledRemotely = true;
        } catch (err) {
          const status = (err as { status?: number }).status ?? (err as { response?: { status?: number } }).response?.status;
          const rawMsg = (err as { data?: { message?: string }; message?: string }).data?.message ?? (err as { message?: string }).message ?? "";
          const msg = typeof rawMsg === "string" ? rawMsg.toLowerCase() : "";
          if (status === 422 || msg.includes("already enrolled")) {
            enrolledRemotely = true;
          } else {
            console.error("Teachable enroll error", { courseId: cid, error: err });
          }
        }

        const exists = (userDoc.courses || []).some((c: CourseAccess) => Number(c.teachableCourseId) === Number(cid));
        if (enrolledRemotely && !exists) {
          userDoc.courses.push({ teachableCourseId: cid, status: "active", enrolledAt: new Date(), expiresAt: null, courseRef: null });
        }
      }

      // Add a "manual" transaction record for tracking
      userDoc.payments.push({
        provider: "other", // or 'manual' if enum allows, but enum is strict in schema? Schema says "other" is allowed.
        amount: 0,
        currency: "USD",
        transactionId: `MANUAL-${Date.now()}`,
        status: "completed",
        createdAt: new Date(),
      });
      const { accountType } = (req.body || {}) as { accountType?: string };
      if (accountType && ["free", "premium", "student", "founder"].includes(accountType)) {
        userDoc.accountType = accountType as IUser["accountType"];
      } else {
        userDoc.accountType = "founder";
      }

      await userDoc.save();
      user = userDoc.toObject();
    }

    // Send email ONLY if we generated a password (new user) OR if explicitly requested?
    // User said: "enviarse el correo con la contraseña".
    // If it's a new user, we have `password`.
    if (isNewUser && password) {
      const emailService = new EmailService();
      await emailService.sendTemporaryPassword(email, name, password);
    }

    const safeUser = {
      _id: user!._id,
      name: user!.name,
      email: user!.email,
      teachableUserId: user!.teachableUserId,
      courses: user!.courses,
      careers: user!.careers,
      payments: user.payments,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      accountType: user.accountType || "free"
    };

    res.status(HttpStatusCode.Ok).send({
      message: "Manual access granted successfully.",
      user: safeUser,
      password: password || undefined // Return password in response just in case admin needs it
    });
    return;

  } catch (error) {
    console.error("Error granting manual access", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "Internal server error." });
    return;
  }
}

export async function requestPasswordRecovery(
  req: Request,
  res: Response,
  _next: NextFunction,
): Promise<void> {
  try {
    const { email } = (req.body || {}) as { email?: string };

    if (!email) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid payload. Email is required." });
      return;
    }

    const trimmedEmail = email.trim();

    const user = await models.users.findOne({ email: trimmedEmail });
    if (!user) {
      res.status(HttpStatusCode.NotFound).send({ message: "User not found." });
      return;
    }

    // Generate token
    const token = randomPassword(32);
    const expires = new Date(Date.now() + 3600000); // 1 hour

    user.recoveryToken = token;
    user.recoveryTokenExpires = expires;
    await user.save();

    // Send email
    const emailService = new EmailService();
    try {
      await emailService.sendPasswordRecovery(user.email, user.name, token);
    } catch (err) {
      console.error("Error sending recovery email", err);
      // Don't fail the request, just log error
    }

    res.status(HttpStatusCode.Ok).send({ message: "Recovery email sent." });
    return;
  } catch (error) {
    console.error("Error requesting password recovery", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "Internal server error." });
    return;
  }
}

export async function resetPassword(
  req: Request,
  res: Response,
  _next: NextFunction,
): Promise<void> {
  try {
    const { token, newPassword } = (req.body || {}) as { token?: string; newPassword?: string };

    if (!token || !newPassword) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid payload. Token and new password are required." });
      return;
    }

    const user = await models.users.findOne({
      recoveryToken: token,
      recoveryTokenExpires: { $gt: new Date() },
    });

    if (!user) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid or expired token." });
      return;
    }

    user.password = newPassword;
    user.recoveryToken = null;
    user.recoveryTokenExpires = null;
    await user.save();

    res.status(HttpStatusCode.Ok).send({ message: "Password reset successfully." });
    return;
  } catch (error) {
    console.error("Error resetting password", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "Internal server error." });
    return;
  }
}

export async function changePassword(
  req: Request,
  res: Response,
  _next: NextFunction,
): Promise<void> {
  try {
    const { userId } = req.params as { userId: string };
    const { currentPassword, newPassword } = (req.body || {}) as { currentPassword?: string; newPassword?: string };

    if (!userId || !Types.ObjectId.isValid(userId)) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid parameter. A valid userId is required." });
      return;
    }

    if (!currentPassword || !newPassword) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid payload. currentPassword and newPassword are required." });
      return;
    }

    if (newPassword.length < 8) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid payload. newPassword must be at least 8 characters." });
      return;
    }

    if (currentPassword === newPassword) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid payload. New password must be different from current password." });
      return;
    }

    const user = await models.users.findById(userId);
    if (!user) {
      res.status(HttpStatusCode.NotFound).send({ message: "User not found." });
      return;
    }

    const matches = await bcrypt.compare(currentPassword, user.password);
    if (!matches) {
      res.status(HttpStatusCode.Unauthorized).send({ message: "Invalid credentials." });
      return;
    }

    user.password = newPassword;
    await user.save();

    res.status(HttpStatusCode.Ok).send({ message: "Password updated successfully." });
    return;
  } catch (error) {
    console.error("Error changing password", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "Internal server error." });
    return;
  }
}

export async function loginWithGoogle(
  req: Request,
  res: Response,
  _next: NextFunction,
): Promise<void> {
  try {
    // Expect req.user from verifyFirebaseToken middleware
    const firebaseUser = (req as any).user;

    if (!firebaseUser) {
      res.status(HttpStatusCode.Unauthorized).send({ message: "User not authenticated via Google." });
      return;
    }

    const { email, name, picture } = firebaseUser;

    if (!email) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid token. Email not found." });
      return;
    }

    let user = await models.users.findOne({ email });

    if (!user) {
      // Create User if not exists
      const password = randomPassword(32);
      user = await models.users.create({
        name: name || "Google User",
        email,
        password,
        accountType: "free"
      });

      // Teachable Logic (replicated from createUser)
      try {
        const teachableService = new TeachableUsersService();
        const createBody: CreateUserBodyParam = { name: user.name, email: user.email, password };
        const teachableRes = await teachableService.createUser(createBody);
        const teachableUserId = extractTeachableUserId(teachableRes);

        if (typeof teachableUserId === "number") {
          user.teachableUserId = teachableUserId;
          await user.save();

          // We do NOT enroll in any course for Google Login (Free Tier)
          // The user starts with 0 courses.
        }
      } catch (teachableErr) {
        console.error("Error creating user in Teachable during Google Login", teachableErr);
      }
    }

    // Generate JWT
    const secret = process.env.JWT_SECRET?.trim();
    if (!secret) {
      console.error("Missing JWT_SECRET env var");
      res.status(HttpStatusCode.InternalServerError).send({ message: "Internal server error." });
      return;
    }

    const jwtToken = jwt.sign(
      { sub: user._id.toString(), email: user.email },
      secret,
      { expiresIn: "7d" },
    );

    const safeUser = {
      _id: user._id,
      name: user.name,
      email: user.email,
      teachableUserId: user.teachableUserId,
      gender: user.gender,
      genderOther: user.genderOther,
      dateOfBirth: user.dateOfBirth,
      heardAboutUs: user.heardAboutUs,
      heardAboutUsOther: user.heardAboutUsOther,
      courses: user.courses,
      careers: user.careers,
      payments: user.payments,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      accountType: user.accountType || "free",
      picture // pass back picture if needed by frontend
    };

    res.status(HttpStatusCode.Ok).send({ message: "Login successful.", token: jwtToken, user: safeUser });
    return;
  } catch (error) {
    console.error("Error logging in with Google", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "Internal server error." });
    return;
  }
}

export async function submitOnboarding(
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

    const {
      jobPosition,
      businessName,
      businessType,
      businessTypeOther,
      employeeCount,
      numberOfLocations,
      heardAboutUs,
      heardAboutUsOther
    } = req.body as {
      jobPosition?: string;
      businessName?: string;
      businessType?: string;
      businessTypeOther?: string;
      employeeCount?: string;
      numberOfLocations?: number;
      heardAboutUs?: string;
      heardAboutUsOther?: string;
    };

    if (!jobPosition) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid payload. Job position is required." });
      return;
    }

    const user = await models.users.findById(userId);
    if (!user) {
      res.status(HttpStatusCode.NotFound).send({ message: "User not found." });
      return;
    }

    if (jobPosition) user.jobPosition = jobPosition.trim();
    if (businessName) user.businessName = businessName.trim();

    const allowedBusinessTypes = ["physical_restaurant", "dark_kitchen", "food_truck", "catering", "bakery", "cafe", "other"];
    if (businessType) {
      if (allowedBusinessTypes.includes(businessType)) {
        user.businessType = businessType as any;
        if (businessType === "other" && businessTypeOther) {
          user.businessTypeOther = businessTypeOther.trim();
        } else {
          user.businessTypeOther = null;
        }
      }
    }

    const allowedEmployeeCounts = ["1-5", "6-10", "11-25", "26-50", "50+"];
    if (employeeCount && allowedEmployeeCounts.includes(employeeCount)) {
      user.employeeCount = employeeCount as any;
    }

    if (numberOfLocations !== undefined && numberOfLocations !== null) {
      const n = Number(numberOfLocations);
      if (!Number.isNaN(n) && n >= 0) {
        user.numberOfLocations = n;
      }
    }

    const allowedHeard = [
      "social_media_ad",
      "friend_colleague",
      "search_engine",
      "online_article_blog",
      "youtube_video",
      "podcast",
      "event_webinar",
      "email_campaign",
      "teachable_marketplace",
      "other",
    ];
    if (heardAboutUs && allowedHeard.includes(heardAboutUs)) {
      user.heardAboutUs = heardAboutUs as any;
      if (heardAboutUs === "other" && heardAboutUsOther) {
        user.heardAboutUsOther = heardAboutUsOther.trim();
      }
    }

    user.onboardingCompleted = true;
    await user.save();

    const safeUser = {
      _id: user._id,
      name: user.name,
      email: user.email,
      teachableUserId: user.teachableUserId,
      onboardingCompleted: user.onboardingCompleted,
      jobPosition: user.jobPosition,
      businessName: user.businessName,
      businessType: user.businessType,
      employeeCount: user.employeeCount,
      numberOfLocations: user.numberOfLocations,
    };

    res.status(HttpStatusCode.Ok).send({
      message: "Onboarding completed successfully.",
      user: safeUser
    });

  } catch (error) {
    console.error("Error submitting onboarding", error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "Internal server error." });
  }
}
