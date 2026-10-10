# REST API v1

База: `/api/v1`. Формат — JSON, ошибки — `application/problem+json` (RFC 9457) с полем `instance` = `x-request-id`.
Авторизация — `Authorization: Bearer <JWT>` (HS256, 7 дней).

| Метод | Путь | Auth | Описание |
|---|---|---|---|
| GET | `/health` | — | Состояние, версия API и контента |
| GET | `/categories` | — | Комплекты билетов (`ticketSets`: ABM, CD), категории и список категорий с неуточнённым комплектом |
| GET | `/content` | — | Банк вопросов; `ETag` + `If-None-Match` → `304` |
| POST | `/auth/register` | — | `{email, password}` → `201 {token, user}`; `422` валидация, `409` занят |
| POST | `/auth/login` | — | `{email, password}` → `200 {token, user}`; `401` единый ответ |
| GET | `/me` | ✓ | Профиль |
| GET | `/me/progress` | ✓ | `{progress, revision}` + `ETag` |
| PUT | `/me/progress` | ✓ | Замена; **`If-Match` обязателен** (`428`); устаревшая ревизия → `409 {current}` |
| POST | `/me/progress/merge` | ✓ | Бесконфликтное слияние присланного прогресса с серверным |
| POST | `/exams` | ✓ | `{ticketSet: "ABM" \| "CD"}` → `201` экзамен без правильных ответов (старое поле `category` тоже принимается) |
| GET | `/exams/:id` | ✓ | Состояние (таймер проверяет сервер); после завершения — разбор с ответами |
| POST | `/exams/:id/answers` | ✓ | `{itemIndex, option}` → `{accepted, correct, addedQuestions, exam}` |

Защита: rate-limit (общий и отдельный для `/auth/*`, `429` + `Retry-After`), лимит тела запроса (`413`),
проверка `Content-Type` (`415`), заголовки `nosniff`, `DENY`, `no-referrer`, CSP, `cache-control: no-store`,
пароли — scrypt с солью, сравнение подписи токена в постоянное время, чужие экзамены → `404`.

Конфигурация через окружение: `PORT`, `HOST`, `JWT_SECRET` (обязателен в production, ≥ 16 символов),
`DATA_FILE`, `CONTENT_FILE`, `CORS_ORIGINS`. Логи — JSON в stdout. Завершение по `SIGTERM` — с дозаписью данных.
