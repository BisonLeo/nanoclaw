---
name: quiz-pdf
description: Process PDFs into quizzes, examine answers, and track frequent errors for review. Use when user sends a PDF or mentions quiz/review/test.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# Quiz PDF Skill

Generate quizzes from uploaded PDFs, grade answers, and track errors for review. Designed for young learners.

## Directory Structure

All data lives under `/workspace/shared/quiz/`:

```
/workspace/shared/quiz/
├── uploaded/          # Raw PDFs copied here
├── quizset/           # Generated quiz sets (one per PDF)
│   └── {slug}/
│       ├── source.txt       # Extracted text from PDF
│       ├── quiz.md           # Generated questions
│       └── state.json        # Progress tracking
└── review/
    ├── frequent_errors.md    # Human-readable error patterns
    └── errors.json           # Machine-readable error log
```

## Workflow

### Phase 1: Ingest PDF

1. Create directories if they don't exist:
   ```bash
   mkdir -p /workspace/shared/quiz/{uploaded,quizset,review}
   ```
2. Copy the PDF to `/workspace/shared/quiz/uploaded/`
3. Create a slug from the filename (lowercase, hyphens, no extension)
4. Extract text:
   ```bash
   pdftotext /workspace/shared/quiz/uploaded/{file}.pdf -
   ```
5. Save extracted text to `/workspace/shared/quiz/quizset/{slug}/source.txt`

### Phase 2: Generate Quiz

Analyze the source text and generate questions in `/workspace/shared/quiz/quizset/{slug}/quiz.md`:

```markdown
# Quiz: {title}
Source: {filename}
Generated: {date}

## Q1. {question text}
- A) ...
- B) ...
- C) ...
- D) ...

**Answer:** {correct letter}
**Explanation:** {why this is correct, citing source text}
```

Initialize `/workspace/shared/quiz/quizset/{slug}/state.json`:
```json
{
  "total": 5,
  "attempted": [],
  "correct": [],
  "wrong": []
}
```

**Present questions one at a time.** Show only the question and choices — do NOT reveal the answer or explanation until the user responds.

### Phase 3: Examine Answers

When the user answers:
1. Compare to the correct answer from the quiz
2. If correct: congratulate briefly, update `state.json` (add question number to `attempted` and `correct`)
3. If wrong:
   - Explain why it's wrong, cite the relevant source text
   - Update `state.json` (add to `attempted` and `wrong`)
   - Append to `/workspace/shared/quiz/review/errors.json` (create if missing):
     ```json
     { "date": "YYYY-MM-DD", "source": "{slug}", "question": "Q1. ...", "user_answer": "B", "correct_answer": "D", "topic": "{concept}", "explanation": "..." }
     ```
     The file holds a JSON array of error objects.
4. Then present the next question

### Phase 4: Update Frequent Errors

After the quiz session ends (all questions attempted or user stops), regenerate `/workspace/shared/quiz/review/frequent_errors.md`:

```markdown
# Frequent Errors Review
Last updated: {date}

## {Topic} ({N} errors)
- Q: {question text} → Your answer: {X}, Correct: {Y}
  Why: {explanation}
```

Group errors by topic/concept, show frequency counts and most recent occurrence.

### Phase 5: Review Mode

When the user asks to "review errors", "practice mistakes", or similar:
1. Load `/workspace/shared/quiz/review/errors.json`
2. Re-quiz on previously wrong questions (prioritize most frequent errors)
3. If the user now answers correctly, note improvement but keep the error history
4. Update error tracking and regenerate `frequent_errors.md`

## State Resume

On each invocation:
1. Check for existing `state.json` files in `/workspace/shared/quiz/quizset/*/`
2. If an incomplete quiz exists (attempted < total), offer to resume or start fresh
3. Each PDF is tracked independently by its slug

## Important Notes

- Keep language age-appropriate and encouraging for young learners
- For bilingual PDFs, present questions in the same language as the source
- Always wait for the user's answer before revealing the correct answer
- If `pdftotext` produces poor output (e.g. scanned images), inform the user and suggest alternatives
