export const EVALUATION_SECTIONS = [
  {
    key: "professional",
    title: "Instructor’s Professional Behavior",
    questions: [
      "He/She has a good sense of responsibility.",
      "He/She is fair and unbiased.",
      "He/She is knowledgeable of subject matter.",
      "He/She is firm in discipline.",
      "He/She observe the session time.",
    ],
  },
  {
    key: "planning",
    title: "Course Instructional Planning and Methodology",
    questions: [
      "He/She gives assignments that are clearly related to course objectives.",
      "He/She is organized and prepared for lectures.",
      "He/She has covered the course outline.",
      "He/She uses a variety of instructional methods to increase interest in content and to promote learning (discussions, technological aids, written material etc).",
      "He/She has effective communication skills.",
      "He/She has prepared effective course outline.",
      "He/She has provided the course outline during the first week.",
    ],
  },
  {
    key: "availability",
    title: "Availability and Interaction",
    questions: [
      "He/She is available during the specified office hours and for after class consultation (in case of visiting / e-mail).",
      "He/She encourages students’ class participation.",
      "He/She provides constructive feedback when appropriate.",
      "He/She listens and understands students’ point of view; He/She may not agree, but respects the opinion.",
    ],
  },
  {
    key: "evaluation",
    title: "Evaluation Tools and Strategies",
    questions: [
      "He/She is clear about methods of evaluation and grading.",
      "He/She returns graded assignments / quizzes with appropriate timeline (One Week).",
    ],
  },
  {
    key: "general",
    title: "General Opinion",
    questions: [
      "The amount of work required and the overall level of difficulty is appropriate to the course objectives.",
      "The instructor stimulated my interest in the subject.",
    ],
  },
];

export const BADGE_RULES = [
  { key: "first_quiz", title: "First Quiz Attempt", when: (p) => p.quizCount >= 1 },
  { key: "quiz_master", title: "Quiz Master", when: (p) => p.quizCount >= 4 },
  { key: "assignment_starter", title: "Assignment Starter", when: (p) => p.assignmentCount >= 1 },
  { key: "consistent_learner", title: "Consistent Learner", when: (p) => p.quizCount >= 2 && p.assignmentCount >= 2 },
];

export const POINTS = {
  QUIZ_SUBMISSION: 20,
  ASSIGNMENT_SUBMISSION: 15,
};
