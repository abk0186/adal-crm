# ADAL CRM — v1

Простая бесплатная CRM для продаж мини-погрузчиков **ADAL MODEL 907**.
Статический PWA (vanilla JS) на GitHub Pages + Supabase (Auth + Postgres, схема `crm`).

- Сайт: https://abk0186.github.io/adal-crm/
- Supabase project: `iwpmrordpxrkxlpaxutx`, схема **`crm`** (другие схемы не затрагиваются)
- В репозитории только публичный publishable/anon key (`config.js`). Доступ к данным режет RLS.

## Что умеет
- Вход по email + пароль (Supabase Auth). Видят данные только члены `crm.team_members`.
- Воронка (канбан): Новая заявка → Связались → Квалификация → КП отправлено → Счёт/договор → Оплата → Отгрузка → Успешно / Отказ.
  На телефоне — горизонтальная прокрутка и выбор этапа в карточке; на компьютере — ещё и перетаскивание.
- «＋ Лид»: сначала телефон, CRM сразу показывает, есть ли такой контакт и открытая сделка.
- Дедуп по телефону (`+7XXXXXXXXXX`): повторный номер не создаёт дубль — добавляется касание в открытую сделку.
- Карточка сделки: все поля, блок квалификации (город, для чего, срок, бюджет, кто решает), задачи, история касаний.
- «Мои задачи» / «Все» / «Выполненные», просроченные подсвечены красным, счётчик на вкладке.
- Фильтр по направлению («Погрузчики»; «Сайты садиков» заведено, но выключено — `crm.directions.active`).
- PWA: «На экран Домой» на iPhone (Safari → Поделиться → На экран «Домой») и Android (Chrome → Установить).

## Автоматика (триггеры БД)
| Событие | Что происходит |
|---|---|
| новая сделка | задача «Связаться», срок — сегодня 23:59 (Алматы) |
| этап → «КП отправлено» | задача «Переспросить по КП», +2 дня |
| этап → «Счёт/договор» | задача «Проверить оплату», +3 дня |
| уход с «Новая заявка» | авто-задача «Связаться» закрывается |
| «Успешно» / «Отказ» | все открытые задачи сделки закрываются |
| любая смена этапа | системная запись в истории касаний |
| «Отказ» без причины | запрещено CHECK-ограничением `deals_lost_reason_required` |

## Структура БД
`sql/` — миграции в порядке применения (применены через Supabase MCP).
- `crm.contacts`, `crm.deals`, `crm.touches`, `crm.tasks`, `crm.directions`
- `crm.team_members` (кто имеет доступ), `crm.allowlist` (кому разрешено), `crm.telegram_chats` (chat_id для напоминаний)
- Схема `crm` не выставлена в Data API. Браузер работает через `public.crm_*` view с `security_invoker = true`
  (RLS таблиц `crm` действует) и RPC `public.crm_create_lead`, `public.crm_find_contact`. У роли `anon` прав нет вообще.
- `crm.ingest_lead(phone, name, source, text)` — для будущей WhatsApp-рутины. Только `service_role` / SQL-админ
  (через REST anon/authenticated недоступна). Та же логика дедупа.

## Первый вход / сброс пароля (самостоятельно)
На экране входа: «Первый вход / Забыли пароль?» → email → RPC `public.crm_access_status(email)`
(`signup` | `reset` | `none`) → `auth.signUp` (со случайным паролем, письмо-подтверждение) или
`auth.resetPasswordForEmail`; для `none` ничего не отправляется. Сообщение всегда одинаковое.
По ссылке из письма открывается экран «Задать пароль» (`updateUser({password})`).
Запасной путь: если ссылка ведёт на `localhost:3000` (Site URL проекта), её можно вставить в поле
«Ссылка из письма не открылась?» — CRM сама проверит код (`verifyOtp` / `setSession`).

Настройки Auth, которые нужны (Dashboard → Authentication → URL Configuration):
- Redirect URLs: добавить `https://abk0186.github.io/adal-crm/` (Site URL не трогать).
- Почта: встроенный SMTP Supabase шлёт письма **только членам команды организации Supabase** и ~2 письма/час.
  Для писем на обычные адреса нужен свой SMTP (например, Gmail SMTP с паролем приложения) — Authentication → Emails → SMTP Settings.

## Как добавить пользователя (админ)
1. В SQL editor Supabase (или через MCP):
   ```sql
   insert into crm.allowlist(email, full_name, role) values ('wife@example.com', 'Айгерим', 'manager');
   ```
2. Supabase Dashboard → Authentication → Users → **Add user** → *Create new user* (email + пароль, *Auto Confirm User*).
   Триггер `crm_on_auth_user_created` сам добавит его в `crm.team_members`.
   Если пользователь уже существовал до записи в allowlist:
   ```sql
   insert into crm.team_members(user_id, email, full_name, role)
   select id, lower(email), 'Айгерим', 'manager' from auth.users where email = 'wife@example.com';
   ```
3. Пароль передать лично (не в Drive и не в чат третьим лицам).
4. Отключить доступ: `update crm.team_members set active = false where email = '…';`

## Telegram-напоминания (план, НЕ подключено)
Бот не создан — нужно «да» владельца. Когда будет токен:
1. Создать бота у @BotFather, токен положить в Supabase Vault / секреты Edge Function (не в репозиторий).
2. Каждый пользователь пишет боту `/start`; его `chat_id` записываем в `crm.telegram_chats`.
3. Edge Function `crm-reminders`: выбирает `crm.tasks` где `not done and due_at <= now() + interval '15 min' and reminded_at is null`,
   шлёт `sendMessage` ответственному, ставит `reminded_at = now()`. Плюс утренний дайджест в 09:00 (Алматы).
4. Запуск через `pg_cron` + `pg_net` каждые 10–15 минут (расширения сейчас не включены).

## WhatsApp-лиды (план)
Рутина читает новые чаты рекламного номера (WhatsApp Web через «Связанные устройства», только после согласия владельца)
и вызывает `select crm.ingest_lead('+77…', 'Имя', 'WhatsApp', 'текст');` от service_role.
Звонки с iPhone автоматически не ловятся — заносятся кнопкой «＋ Лид».

## Локально
`python3 -m http.server 8099` в корне репозитория → http://localhost:8099/
