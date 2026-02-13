import type { Request, Response, NextFunction } from "express";
import { HttpStatusCode } from "axios";
import { Types } from "mongoose";
import { models } from "../models";
import { TeachableCoursesService, TeachableUsersService } from "../services/teachable";
import { PointsService } from "../services/points";
import { EnrollmentService } from "../services/enrollment.service";
import type { TeachableCourse } from "../types/teachable";
import type { CourseAccess } from "../types/user";

function parsePositiveNumber(value: unknown): number | undefined {
  const n = Number(value);
  if (Number.isNaN(n) || n <= 0) return undefined;
  return n;
}

function parseBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true") return true;
    if (v === "false") return false;
  }
  return undefined;
}

export async function getCourses(
  req: Request,
  res: Response,
  _next: NextFunction,
): Promise<void> {
  try {
    const { name, is_published, author_bio_id, created_at, page, per } = (req.query || {}) as Record<string, unknown>;
    const metadata = {
      name: typeof name === "string" ? name : undefined,
      is_published: parseBoolean(is_published),
      author_bio_id: author_bio_id ? parsePositiveNumber(author_bio_id) : undefined,
      created_at: typeof created_at === "string" ? created_at : undefined,
      page: page ? parsePositiveNumber(page) : undefined,
      per: per ? parsePositiveNumber(per) : undefined,
    };

    const service = new TeachableCoursesService();
    const { data } = await service.listCourses(metadata);
    res.status(HttpStatusCode.Ok).send({ message: "Courses retrieved successfully.", courses: data });
    return;
  } catch (error: any) {
    const err = error as { status?: number; message?: string };
    console.error("Error fetching courses", err);
    res.status(err?.status || HttpStatusCode.InternalServerError).send({ message: err?.message || "Internal server error." });
    return;
  }
}

export async function getEnrolledCoursesForUser(
  req: Request,
  res: Response,
  _next: NextFunction,
): Promise<void> {
  try {
    const { userId } = req.params as { userId: string };
    const { teachableUserId } = (req.query || {}) as Record<string, any>;

    let courseIds: number[] = [];

    if (userId && Types.ObjectId.isValid(userId)) {
      const user = await models.users.findById(userId).lean();
      if (!user) {
        res.status(HttpStatusCode.NotFound).send({ message: "User not found." });
        return;
      }
      courseIds = (user.courses || [])
        .filter((c) => c && c.status === "active")
        .map((c) => Number(c.teachableCourseId))
        .filter((n: number) => Number.isFinite(n) && n > 0);
    } else {
      const tId = parsePositiveNumber(teachableUserId);
      if (!tId) {
        res.status(HttpStatusCode.BadRequest).send({ message: "Invalid payload. A valid userId or teachableUserId is required." });
        return;
      }
      const usersService = new TeachableUsersService();
      const { data } = await usersService.showUser({ user_id: tId });
      const enrollments = (data as { enrollments?: Array<{ course_id: number }> })?.enrollments || [];
      courseIds = enrollments
        .map((e) => Number(e?.course_id))
        .filter((n: number) => Number.isFinite(n) && n > 0);
    }

    courseIds = Array.from(new Set(courseIds));

    if (courseIds.length === 0) {
      res.status(HttpStatusCode.Ok).send({ message: "No enrolled courses found.", courses: [] });
      return;
    }

    const service = new TeachableCoursesService();
    const results = await Promise.all(
      courseIds.map(async (cid) => {
        try {
          const { data } = await service.showCourse({ course_id: cid });
          return data;
        } catch (_err) {
          return null;
        }
      }),
    );
    const courses = results.filter((r) => r != null);

    res.status(HttpStatusCode.Ok).send({ message: "Enrolled courses retrieved successfully.", courses });
    return;
  } catch (error: any) {
    const err = error as { status?: number; message?: string };
    console.error("Error fetching enrolled courses", err);
    res.status(err?.status || HttpStatusCode.InternalServerError).send({ message: err?.message || "Internal server error." });
    return;
  }
}

async function resolveTeachableUserId(userId?: string, teachableUserId?: unknown): Promise<number | undefined> {
  const parsedTeachable = parsePositiveNumber(teachableUserId);
  if (parsedTeachable) return parsedTeachable;
  if (userId && Types.ObjectId.isValid(userId)) {
    const user = await models.users.findById(userId).lean();
    const id = parsePositiveNumber(user?.teachableUserId);
    if (id) return id;
  }
  return undefined;
}

async function resolveUserId(userId?: string, teachableUserId?: unknown): Promise<string | undefined> {
  if (userId && Types.ObjectId.isValid(userId)) return userId;
  const parsedTeachable = parsePositiveNumber(teachableUserId);
  if (parsedTeachable) {
    const user = await models.users.findOne({ teachableUserId: parsedTeachable }).lean();
    return user?._id?.toString();
  }
  return undefined;
}

export async function enrollUserToCourse(
  req: Request,
  res: Response,
  _next: NextFunction,
): Promise<void> {
  try {
    const { courseId } = req.params;
    const courseIdNum = parsePositiveNumber(courseId);
    if (!courseIdNum) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid parameter. A valid courseId is required." });
      return;
    }

    const { userId, teachableUserId } = (req.body || {}) as Record<string, any>;
    const finalTeachableUserId = await resolveTeachableUserId(userId, teachableUserId);
    if (!finalTeachableUserId) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid payload. A valid teachableUserId or userId is required." });
      return;
    }

    const usersService = new TeachableUsersService();
    await usersService.enrollUser({ user_id: finalTeachableUserId, course_id: courseIdNum } as any);

    if (userId && Types.ObjectId.isValid(userId)) {
      const localUser = await models.users.findById(userId);
      if (localUser) {
        const exists = (localUser.courses || []).some((c: CourseAccess) => Number(c.teachableCourseId) === Number(courseIdNum));
        if (!exists) {
          localUser.courses.push({ teachableCourseId: courseIdNum, status: "active", enrolledAt: new Date(), expiresAt: null, courseRef: null });
          await localUser.save();
        }
      }
    }

    res.status(HttpStatusCode.NoContent).send({ message: "User enrolled successfully." });
    return;
  } catch (error: any) {
    console.error("Error enrolling user in course", error);
    res.status(error?.status || HttpStatusCode.InternalServerError).send({ message: error?.message || "Internal server error." });
    return;
  }
}

export async function enrollUserToAllCourses(
  req: Request,
  res: Response,
  _next: NextFunction,
): Promise<void> {
  try {
    const { userId } = (req.params || {}) as Record<string, any>;

    if (userId && Types.ObjectId.isValid(userId)) {
      const enrollmentService = new EnrollmentService();
      const { enrolled, failed } = await enrollmentService.enrollUserInAllAvailableCourses(userId);
      res.status(HttpStatusCode.Ok).send({ message: "User enrolled in all courses successfully.", enrolledCourseIds: enrolled, failedCourseIds: failed });
      return;
    }

    const { teachableUserId } = (req.query || {}) as Record<string, any>;
    const finalTeachableUserId = await resolveTeachableUserId(undefined, teachableUserId);
    if (!finalTeachableUserId) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid payload. A valid teachableUserId or userId is required." });
      return;
    }

    const coursesService = new TeachableCoursesService();
    const usersService = new TeachableUsersService();

    const perDefault = 200;
    let page = 1;
    const collectedIds: number[] = [];

    while (true) {
      let data: any[] = [];
      try {
        const resCourses = await coursesService.listCourses({ page, per: perDefault } as any);
        data = (resCourses as any)?.data ?? [];
      } catch (_err) {
        break;
      }
      const ids = (Array.isArray(data) ? data : [])
        .map((c: TeachableCourse) => Number(c.id))
        .filter((n: number) => Number.isFinite(n) && n > 0);
      if (ids.length === 0) break;
      collectedIds.push(...ids);
      if (ids.length < perDefault) break;
      page += 1;
    }

    const uniqueCourseIds = Array.from(new Set(collectedIds));

    if (uniqueCourseIds.length === 0) {
      res.status(HttpStatusCode.Ok).send({ message: "No courses available to enroll.", enrolledCourseIds: [], failedCourseIds: [] });
      return;
    }

    const results = await Promise.allSettled(
      uniqueCourseIds.map(async (cid) => {
        await usersService.enrollUser({ user_id: finalTeachableUserId, course_id: cid } as any);
        return cid;
      }),
    );

    const enrolledCourseIds: number[] = [];
    const failedCourseIds: number[] = [];
    for (const r of results) {
      if (r.status === "fulfilled") enrolledCourseIds.push(r.value as number);
      else {
        const reason: any = (r as any).reason;
        const cid = Number(reason?.course_id ?? reason?.metadata?.course_id);
        if (Number.isFinite(cid) && cid > 0) failedCourseIds.push(cid);
      }
    }

    res.status(HttpStatusCode.Ok).send({ message: "User enrolled in all courses successfully.", enrolledCourseIds, failedCourseIds });
    return;
  } catch (error: any) {
    console.error("Error enrolling user in all courses", error);
    res.status(error?.status || HttpStatusCode.InternalServerError).send({ message: error?.message || "Internal server error." });
    return;
  }
}

export async function getCourseById(
  req: Request,
  res: Response,
  _next: NextFunction,
): Promise<void> {
  try {
    const { courseId } = req.params;
    const courseIdNum = parsePositiveNumber(courseId);
    if (!courseIdNum) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid parameter. A valid courseId is required." });
      return;
    }

    const service = new TeachableCoursesService();
    const { data } = await service.showCourse({ course_id: courseIdNum } as any);
    const raw: any = data as any;
    const courseObj: any = raw?.course ?? raw;
    const sections: any[] = Array.isArray(courseObj?.lecture_sections) ? [...courseObj.lecture_sections] : [];
    sections.sort((a: any, b: any) => {
      const pa = Number(a?.position);
      const pb = Number(b?.position);
      const va = Number.isFinite(pa) ? pa : Number.MAX_SAFE_INTEGER;
      const vb = Number.isFinite(pb) ? pb : Number.MAX_SAFE_INTEGER;
      return va - vb;
    });
    for (const s of sections) {
      if (Array.isArray(s?.lectures)) {
        s.lectures = [...s.lectures].sort((la: any, lb: any) => {
          const pa = Number(la?.position);
          const pb = Number(lb?.position);
          const va = Number.isFinite(pa) ? pa : Number.MAX_SAFE_INTEGER;
          const vb = Number.isFinite(pb) ? pb : Number.MAX_SAFE_INTEGER;
          return va - vb;
        });
      }
    }
    const orderedCourse = { ...courseObj, lecture_sections: sections };
    const finalData = raw?.course ? { ...raw, course: orderedCourse } : orderedCourse;
    res.status(HttpStatusCode.Ok).send({ message: "Course retrieved successfully.", course: finalData });
    return;
  } catch (error: any) {
    console.error("Error fetching course", error);
    res.status(error?.status || HttpStatusCode.InternalServerError).send({ message: error?.message || "Internal server error." });
    return;
  }
}

export async function getCourseEnrollments(
  req: Request,
  res: Response,
  _next: NextFunction,
): Promise<void> {
  try {
    const { courseId } = req.params;
    const courseIdNum = parsePositiveNumber(courseId);
    if (!courseIdNum) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid parameter. A valid courseId is required." });
      return;
    }

    const { enrolled_in_after, enrolled_in_before, sort_direction, page, per } = (req.query || {}) as Record<string, any>;
    const metadata = {
      course_id: courseIdNum,
      enrolled_in_after: typeof enrolled_in_after === "string" ? enrolled_in_after : undefined,
      enrolled_in_before: typeof enrolled_in_before === "string" ? enrolled_in_before : undefined,
      sort_direction: typeof sort_direction === "string" ? sort_direction : undefined,
      page: page ? parsePositiveNumber(page) : undefined,
      per: per ? parsePositiveNumber(per) : undefined,
    } as any;

    const service = new TeachableCoursesService();
    const { data } = await service.showCourseEnrollments(metadata);
    res.status(HttpStatusCode.Ok).send({ message: "Course enrollments retrieved successfully.", enrollments: data });
    return;
  } catch (error: any) {
    console.error("Error fetching course enrollments", error);
    res.status(error?.status || HttpStatusCode.InternalServerError).send({ message: error?.message || "Internal server error." });
    return;
  }
}

export async function getLectureById(
  req: Request,
  res: Response,
  _next: NextFunction,
): Promise<void> {
  try {
    const { courseId, lectureId } = req.params;
    const courseIdNum = parsePositiveNumber(courseId);
    const lectureIdNum = parsePositiveNumber(lectureId);
    if (!courseIdNum || !lectureIdNum) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid parameter. Valid courseId and lectureId are required." });
      return;
    }

    const service = new TeachableCoursesService();
    const { data } = await service.showLecture({ course_id: courseIdNum, lecture_id: lectureIdNum } as any);
    res.status(HttpStatusCode.Ok).send({ message: "Lecture retrieved successfully.", lecture: data });
    return;
  } catch (error: any) {
    console.error("Error fetching lecture", error);
    res.status(error?.status || HttpStatusCode.InternalServerError).send({ message: error?.message || "Internal server error." });
    return;
  }
}

export async function completeLectureForUser(
  req: Request,
  res: Response,
  _next: NextFunction,
): Promise<void> {
  try {
    const { courseId, lectureId } = req.params;
    const courseIdNum = parsePositiveNumber(courseId);
    const lectureIdNum = parsePositiveNumber(lectureId);
    if (!courseIdNum || !lectureIdNum) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid parameter. Valid courseId and lectureId are required." });
      return;
    }

    const { userId, teachableUserId } = (req.body || {}) as Record<string, any>;
    const finalTeachableUserId = await resolveTeachableUserId(userId, teachableUserId);
    if (!finalTeachableUserId) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid payload. A valid teachableUserId or userId is required." });
      return;
    }

    const service = new TeachableCoursesService();
    await service.markLectureComplete({ user_id: finalTeachableUserId } as any, { course_id: courseIdNum, lecture_id: lectureIdNum } as any);

    // Award points for completing the lecture
    // Award points for completing the lecture
    const resolvedUserId = await resolveUserId(userId, teachableUserId);
    if (resolvedUserId) {
      const pointsService = new PointsService();
      await pointsService.awardLecturePoint(resolvedUserId, courseIdNum, lectureIdNum);

      // Background Sync for Dashboard
      // We fetch the new progress to ensure our local DB is accurate (incrementing locally might desync if Teachable logic differs)
      try {
        // We need page/per to fetch progress, but for sync we just want the summary stats.
        // Teachable might default to page 1.
        // NOTE: If course is huge, we might not get all sections in one go if paginated.
        // Ideally we used the "progress" endpoint which returns a summary?
        // Teachable SDK `courseProgress` calls `/courses/:id/enrollments/:uid` or similar.
        // Let's assume fetching page 1 is enough for most cases or the endpoint returns aggregate %?
        // Teachable API v1: `GET /courses/:course_id/enrollments/:user_id` returns percent_complete in root.
        const { data } = await service.courseProgress({ course_id: courseIdNum, user_id: finalTeachableUserId } as any);

        const enrollmentService = new EnrollmentService();
        await enrollmentService.syncCourseProgress(resolvedUserId, courseIdNum, data);
      } catch (syncError) {
        console.error("Sync after completion failed:", syncError);
      }
    }

    res.status(HttpStatusCode.NoContent).send({ message: "Lecture marked as complete." });
    return;
  } catch (error: any) {
    console.error("Error marking lecture complete", error);
    res.status(error?.status || HttpStatusCode.InternalServerError).send({ message: error?.message || "Internal server error." });
    return;
  }
}

export async function getCourseProgressForUser(
  req: Request,
  res: Response,
  _next: NextFunction,
): Promise<void> {
  try {
    const { courseId, userId } = req.params as { courseId: string; userId: string };
    const courseIdNum = parsePositiveNumber(courseId);
    if (!courseIdNum) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid parameter. A valid courseId is required." });
      return;
    }

    const { teachableUserId, page, per } = (req.query || {}) as Record<string, any>;
    const finalTeachableUserId = await resolveTeachableUserId(userId, teachableUserId);
    if (!finalTeachableUserId) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid payload. A valid teachableUserId or userId is required." });
      return;
    }

    const service = new TeachableCoursesService();

    // Auto-enrollment logic for founders
    const userIdStr = await resolveUserId(userId, teachableUserId);
    if (userIdStr) {
      const user = await models.users.findById(userIdStr);
      if (user && user.accountType === "founder") {
        const isEnrolled = (user.courses || []).some(
          (c) => Number(c.teachableCourseId) === courseIdNum && c.status === "active"
        );

        if (!isEnrolled) {
          const tId = Number(user.teachableUserId);
          if (tId) {
            try {
              const usersService = new TeachableUsersService();
              await usersService.enrollUser({ user_id: tId, course_id: courseIdNum });

              // Sync local DB
              const exists = (user.courses || []).some(
                (c) => Number(c.teachableCourseId) === courseIdNum
              );
              if (!exists) {
                user.courses.push({
                  teachableCourseId: courseIdNum,
                  status: "active",
                  enrolledAt: new Date(),
                  expiresAt: null,
                  courseRef: null,
                } as any);
                await user.save();
              }
            } catch (enrollError) {
              console.error(`Auto-enrollment failed for founder ${userIdStr} in course ${courseIdNum}:`, enrollError);
              // We continue because they might still have access in Teachable or we want to show the error from courseProgress
            }
          }
        }
      }
    }

    const { data } = await service.courseProgress({ course_id: courseIdNum, user_id: finalTeachableUserId, page: page ? parsePositiveNumber(page) : undefined, per: per ? parsePositiveNumber(per) : undefined } as any);

    // Sync progress to local DB for Dashboard
    try {
      const resolvedUserId = await resolveUserId(userId, teachableUserId);
      if (resolvedUserId) {
        const enrollmentService = new EnrollmentService();
        await enrollmentService.syncCourseProgress(resolvedUserId, courseIdNum, data);
      }
    } catch (syncError) {
      console.error("Background sync failed:", syncError);
    }

    res.status(HttpStatusCode.Ok).send({ message: "Course progress retrieved successfully.", progress: data });
    return;
  } catch (error: any) {
    console.error("Error fetching course progress", error);
    res.status(error?.status || HttpStatusCode.InternalServerError).send({ message: error?.message || "Internal server error." });
    return;
  }
}

export async function getLectureQuizzes(
  req: Request,
  res: Response,
  _next: NextFunction,
): Promise<void> {
  try {
    const { courseId, lectureId } = req.params;
    const courseIdNum = parsePositiveNumber(courseId);
    const lectureIdNum = parsePositiveNumber(lectureId);
    if (!courseIdNum || !lectureIdNum) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid parameter. Valid courseId and lectureId are required." });
      return;
    }

    const service = new TeachableCoursesService();
    const { data } = await service.listQuizzes({ course_id: courseIdNum, lecture_id: lectureIdNum } as any);
    res.status(HttpStatusCode.Ok).send({ message: "Quizzes retrieved successfully.", quizzes: data });
    return;
  } catch (error: any) {
    console.error("Error fetching quizzes", error);
    res.status(error?.status || HttpStatusCode.InternalServerError).send({ message: error?.message || "Internal server error." });
    return;
  }
}

export async function getQuizById(
  req: Request,
  res: Response,
  _next: NextFunction,
): Promise<void> {
  try {
    const { courseId, lectureId, quizId } = req.params;
    const courseIdNum = parsePositiveNumber(courseId);
    const lectureIdNum = parsePositiveNumber(lectureId);
    const quizIdNum = parsePositiveNumber(quizId);
    if (!courseIdNum || !lectureIdNum || !quizIdNum) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid parameter. Valid courseId, lectureId and quizId are required." });
      return;
    }

    const service = new TeachableCoursesService();
    const { data } = await service.showQuiz({ course_id: courseIdNum, lecture_id: lectureIdNum, quiz_id: quizIdNum } as any);
    res.status(HttpStatusCode.Ok).send({ message: "Quiz retrieved successfully.", quiz: data });
    return;
  } catch (error: any) {
    console.error("Error fetching quiz", error);
    res.status(error?.status || HttpStatusCode.InternalServerError).send({ message: error?.message || "Internal server error." });
    return;
  }
}

export async function getQuizResponses(
  req: Request,
  res: Response,
  _next: NextFunction,
): Promise<void> {
  try {
    const { courseId, lectureId, quizId } = req.params;
    const courseIdNum = parsePositiveNumber(courseId);
    const lectureIdNum = parsePositiveNumber(lectureId);
    const quizIdNum = parsePositiveNumber(quizId);
    if (!courseIdNum || !lectureIdNum || !quizIdNum) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid parameter. Valid courseId, lectureId and quizId are required." });
      return;
    }

    const service = new TeachableCoursesService();
    const { data } = await service.showQuizResponses({ course_id: courseIdNum, lecture_id: lectureIdNum, quiz_id: quizIdNum } as any);
    res.status(HttpStatusCode.Ok).send({ message: "Quiz responses retrieved successfully.", responses: data });
    return;
  } catch (error: any) {
    console.error("Error fetching quiz responses", error);
    res.status(error?.status || HttpStatusCode.InternalServerError).send({ message: error?.message || "Internal server error." });
    return;
  }
}

export async function getVideoById(
  req: Request,
  res: Response,
  _next: NextFunction,
): Promise<void> {
  try {
    const { courseId, lectureId, videoId } = req.params;
    const courseIdNum = parsePositiveNumber(courseId);
    const lectureIdNum = parsePositiveNumber(lectureId);
    const videoIdNum = parsePositiveNumber(videoId);
    if (!courseIdNum || !lectureIdNum || !videoIdNum) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid parameter. Valid courseId, lectureId and videoId are required." });
      return;
    }

    const service = new TeachableCoursesService();
    const { data } = await service.showVideo({ course_id: courseIdNum, lecture_id: lectureIdNum, video_id: videoIdNum } as any);
    res.status(HttpStatusCode.Ok).send({ message: "Video retrieved successfully.", video: data });
    return;
  } catch (error: any) {
    console.error("Error fetching video", error);
    res.status(error?.status || HttpStatusCode.InternalServerError).send({ message: error?.message || "Internal server error." });
    return;
  }
}

export async function getNextVideo(
  req: Request,
  res: Response,
  _next: NextFunction,
): Promise<void> {
  try {
    const { courseId, lectureId, videoId } = req.params;
    const courseIdNum = parsePositiveNumber(courseId);
    const lectureIdNum = parsePositiveNumber(lectureId);
    const videoIdNum = parsePositiveNumber(videoId);
    if (!courseIdNum || !lectureIdNum || !videoIdNum) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid parameter. Valid courseId, lectureId and videoId are required." });
      return;
    }

    const service = new TeachableCoursesService();
    const { data: lectureData } = await service.showLecture({ course_id: courseIdNum, lecture_id: lectureIdNum } as any);

    function extractCandidates(obj: any): Array<{ id: number; position?: number }> {
      const out: Array<{ id: number; position?: number }> = [];
      if (!obj || typeof obj !== "object") return out;
      for (const key of Object.keys(obj)) {
        const val = (obj as any)[key];
        if (Array.isArray(val)) {
          const keyLower = key.toLowerCase();
          const looksLikeVideos = keyLower.includes("video");
          if (looksLikeVideos) {
            for (const item of val) {
              const id = Number((item as any)?.id);
              const position = Number((item as any)?.position);
              if (Number.isFinite(id) && id > 0) {
                out.push({ id, position: Number.isFinite(position) ? position : undefined });
              }
            }
          } else {
            // Scan nested arrays for items with type: 'video'
            for (const item of val) {
              const type = String((item as any)?.type || "").toLowerCase();
              const id = Number((item as any)?.id);
              const position = Number((item as any)?.position);
              if (type.includes("video") && Number.isFinite(id) && id > 0) {
                out.push({ id, position: Number.isFinite(position) ? position : undefined });
              }
            }
          }
        } else if (val && typeof val === "object") {
          out.push(...extractCandidates(val));
        }
      }
      return out;
    }

    let videos = extractCandidates(lectureData);
    if (videos.length === 0) {
      res.status(HttpStatusCode.NotFound).send({ message: "No videos found in lecture." });
      return;
    }

    videos = videos.sort((a, b) => {
      const pa = a.position ?? Number.MAX_SAFE_INTEGER;
      const pb = b.position ?? Number.MAX_SAFE_INTEGER;
      if (pa !== pb) return pa - pb;
      return a.id - b.id;
    });

    const idx = videos.findIndex(v => Number(v.id) === Number(videoIdNum));
    const next = idx >= 0 ? videos[idx + 1] : videos.find(v => v.id > videoIdNum);

    if (!next) {
      res.status(HttpStatusCode.Ok).send({ message: "No next video available.", next: null });
      return;
    }

    const { data: nextData } = await service.showVideo({ course_id: courseIdNum, lecture_id: lectureIdNum, video_id: next.id } as any);
    res.status(HttpStatusCode.Ok).send({ message: "Next video retrieved successfully.", next: nextData });
    return;
  } catch (error: any) {
    console.error("Error fetching next video", error);
    res.status(error?.status || HttpStatusCode.InternalServerError).send({ message: error?.message || "Internal server error." });
    return;
  }
}

export async function enrollAllUsersToAllCourses(
  _req: Request,
  res: Response,
  _next: NextFunction,
): Promise<void> {
  try {
    const enrollmentService = new EnrollmentService();
    const result = await enrollmentService.enrollAllFoundersInAllCourses();

    res.status(HttpStatusCode.Ok).send({ message: "All founders enrolled to all courses successfully.", processedUsers: result.processedUsers, enrolledCount: result.enrolledCount });
    return;
  } catch (error: any) {
    console.error("Error enrolling all founders to all courses", error);
    res.status(error?.status || HttpStatusCode.InternalServerError).send({ message: error?.message || "Internal server error." });
    return;
  }
}

export async function revokeAccessForNonFounders(
  _req: Request,
  res: Response,
  _next: NextFunction,
): Promise<void> {
  try {
    const usersService = new TeachableUsersService();
    const batchSize = 50; // Smaller batch for safety
    const concurrency = 3;
    let processedUsers = 0;
    let revokedOperations = 0;

    while (true) {
      // Find users who are NOT founders and have at least one course
      // We keep skip at 0 because we are modifying documents to no longer match the query
      const users = await models.users
        .find(
          {
            accountType: { $ne: "founder" },
            courses: { $exists: true, $not: { $size: 0 } }
          },
          { teachableUserId: 1, courses: 1 }
        )
        .limit(batchSize);

      if (!users || users.length === 0) break;
      processedUsers += users.length;

      const tasks = users.map((u) => async () => {
        const tId = Number(u.teachableUserId);
        const coursesToRevoke = u.courses || [];

        if (coursesToRevoke.length === 0) return;

        // Revoke in Teachable if valid teachableUserId
        if (Number.isFinite(tId) && tId > 0) {
          for (const course of coursesToRevoke) {
            const cId = Number(course.teachableCourseId);
            if (Number.isFinite(cId) && cId > 0) {
              try {
                await usersService.unenrollUser({ user_id: tId, course_id: cId });
                revokedOperations++;
              } catch (err) {
                // Ignore 404s (already unenrolled)
                console.error(`Failed to unenroll user ${tId} from course ${cId}`, err);
              }
            }
          }
        }

        // Update local DB: Remove all courses
        u.courses = [];
        await u.save();
      });

      let i = 0;
      const runners: Promise<void>[] = [];
      while (i < tasks.length) {
        const slice = tasks.slice(i, i + concurrency);
        runners.push(Promise.all(slice.map((fn) => fn())).then(() => { }));
        i += concurrency;
      }
      for (const r of runners) await r;
    }

    res.status(HttpStatusCode.Ok).send({
      message: "Revocation process completed successfully.",
      processedUsers,
      revokedOperations
    });
    return;
  } catch (error: any) {
    console.error("Error revoking access for non-founders", error);
    res.status(error?.status || HttpStatusCode.InternalServerError).send({ message: error?.message || "Internal server error." });
    return;
  }
}


export async function notificationNewCourseForUsers(req: Request, res: Response, _next: NextFunction): Promise<void> {
  try {



  } catch (error: any) {
    console.error("Error notifying new course for users", error);
    res.status(error?.status || HttpStatusCode.InternalServerError).send({ message: error?.message || "Internal server error." });
    return;
  }
}