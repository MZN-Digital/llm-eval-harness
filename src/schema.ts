import { z } from "zod";

/**
 * The shape the model must produce.
 *
 * Every field except `title` is nullable, and that is the single most
 * important decision in this file. A model asked for a due date will invent
 * one rather than return null — it has been trained to be helpful, and an
 * empty field reads to it as an unhelpful answer. Making null a first-class,
 * documented value is what makes "I don't know" available as an answer at all.
 *
 * The eval measures whether that actually worked: `hallucinated_field` is the
 * failure class that counts how often the model filled something the input
 * never said.
 */
export const TaskSchema = z.object({
  /** What is to be done. The only field that may never be null. */
  title: z.string().min(1),

  /**
   * Who is to do it, or who it concerns — as written in the input.
   *
   * Deliberately not normalised to a person record. "Ayşe" and "Ayşe Yılmaz"
   * stay as they arrived; resolving them to the same person is a different
   * problem with a different failure mode, and mixing the two would make a
   * retrieval bug look like an extraction bug.
   */
  assignee: z.string().nullable(),

  /**
   * ISO 8601 date, or null.
   *
   * Relative expressions ("tomorrow", "next Tuesday") are resolved against a
   * reference date passed in at call time rather than the wall clock. Without
   * that, the same eval case would produce a different answer every day and
   * the regression suite would be worthless.
   */
  due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),

  /** hh:mm, 24-hour, or null. */
  time: z.string().regex(/^\d{2}:\d{2}$/).nullable(),

  /**
   * Coarse on purpose. A five-level scale invites the model to split hairs it
   * has no evidence for; three levels can be judged from the words actually
   * present ("urgent", "when you get a chance", or neither).
   */
  priority: z.enum(["high", "normal", "low"]).nullable(),
});

export type Task = z.infer<typeof TaskSchema>;

export const ExtractionSchema = z.object({
  tasks: z.array(TaskSchema),
});

export type Extraction = z.infer<typeof ExtractionSchema>;
