# Running Tracker — System Design Document v1.0

Дата: 19 сентября 2026  
Статус: согласованный проект архитектуры; реализация и нагрузочные проверки ещё не выполнены.  
Область: персональный учебный проект для практики backend, геоданных и fullstack-архитектуры.

Этот документ заменяет фрагменты v0.1–v0.5. При расхождении действует v1.0. Численные ограничения, не заданные пользователем, являются начальными проектными параметрами, подлежащими проверке.

## 1. Назначение и границы

Пользователь записывает пробежку. Тренер с явным разрешением наблюдает текущую позицию и трек. После завершения сохраняются история, статистика и архивная линия на карте.

Организации — беговые клубы. Пробежка принадлежит одному пользователю и одной организации. Членство или роль тренера не открывают чужие координаты автоматически.

Mapbox предоставляет базовую карту. Наш Node.js backend генерирует MVT-тайлы архивных пробежек. Активный трек и маркеры рисуются отдельным динамическим слоем.

Включено:

- надёжный приём измерений, повторы и офлайн-догрузка;
- обработка GPS-качества, история, архивные сводки;
- изоляция организаций и разрешения на пробежку;
- live-наблюдение, восстановление состояния;
- генерация и кэширование приватных тайлов.

Не включено: routing, dispatch, map matching, чат, удалённое управление записью тренером, фоновые гарантии мобильного GPS, multiregion и высокая доступность.

Это практика смежных компетенций вакансии Mapbox Data Tooling, а не копия внутренней архитектуры Mapbox.

## 2. Требования и расчёт нагрузки

| Параметр | Решение |
|---|---|
| Пользователи | До 10; один активный run на пользователя |
| География | Глобальное хранение WGS84; карта ограничена Web Mercator |
| Запись | Браузер в foreground или воспроизводимый GPS-симулятор |
| Источник run | Одно устройство, без передачи записи другому |
| Частота | Целевая: новая точка раз в 2 с; API устройства не гарантирует интервал |
| Длительность | До 24 часов с момента создания run на сервере |
| Пачка | 1–100 уникальных seq; до 64 КиБ JSON |
| Защитный предел | 50 000 исходных точек на run |
| Офлайн | Локальный буфер, догрузка до 24 часов после серверного завершения |
| Raw retention | Целевые 7 дней после finished_at |
| Архив | 1 год после finished_at, либо до удаления владельцем |
| Live | Цель p95 ≤ 5 с от свежего измерения до экрана наблюдателя при нормальной связи |
| Архивная карта | Цель ≤ 60 с после commit опубликованной сводки, в активной вкладке |
| Размещение | Один регион, один backend-процесс и один PostgreSQL |
| Бюджет | Цель ≤ €30/мес. без карт; тарифы и конфигурация ещё не выбраны |

Нагрузка: 10 / 2 = 5 новых точек/с. При часовой ежедневной пробежке каждого пользователя — 18 000 точек/день и 126 000 за неделю. При непрерывной записи — около 3,0 млн за неделю. За год — примерно 3 650 архивных run при обычном сценарии.

Первоначальная оценка 200–400 байт/точку была до окончательного набора индексов. Для планирования v1.0 резервируем 300–600 байт с индексами: около 38–76 МБ на 126 000 точек; WAL, backups, bloat и свободное место считаются отдельно. Проверяем реальное значение через pg_total_relation_size на итоговой схеме.

10 наблюдателей, каждый видит всех 10 бегунов: до 100 записей компактного состояния за один цикл. Для SSE это до 5 сообщений/с при цикле 2 с и одном сообщении на наблюдателя. Изменения треков догружаются отдельно.

Браузерная запись не гарантируется при скрытой вкладке/блокировке экрана. Не создаём новые точки из устаревшего измерения ради соблюдения частоты. Для реального background tracking потребуется мобильный клиент. [Geolocation](https://www.w3.org/TR/geolocation/)

## 3. Архитектура

~~~mermaid
flowchart LR
    R["React: бегун + локальный буфер"] -->|"HTTPS: команды, GPS"| API["NestJS API"]
    C["React: тренер"] -->|"HTTP: snapshots / changes"| API
    API -->|"SSE: актуальные состояния"| C
    API --> DB[("PostgreSQL + PostGIS")]
    W["Фоновые задачи в backend"] --> DB
    C -->|"Z/X/Y + revision"| T["Tile handler + LRU"]
    T --> DB
    R --> M["Mapbox: базовая карта"]
    C --> M
~~~

Один модульный монолит: Identity/Access, Runs/Ingestion, TrackProcessing, Live, ArchiveTiles, Maintenance. Фоновые задачи — модули того же развёртывания; состояние задач восстанавливается из БД.

Геометрия для MVT обрабатывается в PostGIS, а не переносится целиком в Node.js. LRU хранит готовые бинарные тайлы. Redis, Kafka, Kubernetes и отдельная time-series БД для MVP не нужны.

## 4. Реестр решений и альтернатив

| Решение | Обоснование | Что изменит выбор |
|---|---|---|
| PostgreSQL + PostGIS | Ограничения целостности, ACL, SQL и пространственные операции | Существующий Mongo-стек с документными сценариями и меньшей геообработкой |
| Отдельные immutable точки | Идемпотентность, поздняя доставка, последовательное чтение | Не меняем на растущий массив при росте нагрузки |
| SSE + HTTP | Наблюдение однонаправленное; запись уже HTTP | Частый двусторонний обмен может оправдать WebSocket |
| Polling остаётся альтернативой | Для 10 пользователей раз в 2 с достаточно | Предпочтителен, если эксплуатационная простота важнее практики streaming |
| MVT по запросу в PostGIS | Обработка рядом с данными, индивидуальные права | Очень высокая нагрузка или публичные стабильные наборы → предварительная генерация |
| LRU процесса | Один backend, небольшой объём | Несколько реплик с выгодой общего кэша → Redis |
| Полный пересчёт итоговой сводки | Простой контроль поздних точек | Большие run/дорогая обработка → инкрементальные или секционные расчёты |
| Без run_latest | Индексное получение последних точек дешёво | Большой поток proximity-запросов → отдельная current-position проекция |

MongoDB 2dsphere подходит для proximity и геообластей. При пяти точках в секунду нет основания объявлять одну БД «быстрее» без измерений. Time-series коллекции MongoDB имеют отдельные ограничения, включая unique indexes и часть geo-операций; их нельзя считать прозрачной заменой обычной коллекции. [MongoDB](https://www.mongodb.com/docs/manual/core/timeseries/timeseries-limitations/)

## 5. Логическая схема

UUID используются для идентификаторов, timestamptz — для времени, bigint — для seq/revisions. В JSON bigint передаётся десятичной строкой; сравнение на клиенте через BigInt, не лексикографически.

### 5.1 Таблицы

| Таблица | Ключевые поля |
|---|---|
| users | id, идентификатор внешней identity |
| organizations | id, archive_revision |
| memberships | org_id, user_id, role, active |
| runs | org_id, id, user_id, status, started_at, created_at, finished_at, data_revision, control_revision, raw_state |
| run_commands | org_id, run_id, command_id, canonical_payload, response, received_at |
| run_points | org_id, run_id, seq, segment_id, recorded_at, received_at, geom, accuracy_m, ingested_revision |
| run_summaries | org_id, run_id, source_revision, algorithm_version, display_geom, distance_m, observed_duration_s, quality_stats, computed_at |
| run_shares | org_id, run_id, grantee_user_id, can_read_history, can_read_live |
| run_tombstones | org_id, run_id, owner_user_id, deleted_at, expires_at; без координат |

run_tombstones не имеет каскадного FK на удаляемый run. Запись tombstone и удаление run выполняются атомарно. Экспорт журнала удалений для disaster recovery — отдельная эксплуатационная обязанность, описанная в разделе 12.

raw_state: available → purging → purged. status: recording ↔ paused → finished. finished — терминальное состояние.

geom: geometry(Point,4326), longitude первым. display_geom: geometry(MultiLineString,4326), nullable при отсутствии допустимых участков.

Составной PK run_points: (org_id, run_id, seq). Составной FK на runs(org_id,id), ON DELETE CASCADE. Аналогичные связи у shares, summaries и commands.

memberships деактивируем вместо удаления связанной записи: выход из клуба не должен каскадно уничтожать пробежки. Деактивация запрещает новый доступ и участие в shares.

### 5.2 Версии

| Версия | Область | Когда меняется |
|---|---|---|
| data_revision | Один run | Новые точки или изменение статуса |
| control_revision | Один run | Принятая команда жизненного цикла |
| ingested_revision | Одна точка | Фиксируется при первой вставке; неизменна |
| source_revision | Одна сводка | Версия run, по которой выполнен расчёт |
| archive_revision | Организация | Публикация сводки, удаление, изменения archive ACL/membership |
| algorithm_version | Обработка трека | Изменение правил фильтрации/геометрии |

control_revision отделена от data_revision: GPS-записи не должны постоянно конфликтовать с pause/resume.

### 5.3 Индексы

- runs: PK (org_id,id); (org_id,user_id,started_at DESC,id DESC).
- runs: partial UNIQUE(user_id) WHERE status IN ('recording','paused').
- runs: (finished_at) WHERE status='finished'.
- run_points: PK (org_id,run_id,seq).
- run_points: (org_id,run_id,ingested_revision,seq) для восстановления изменений.
- run_summaries: PK (org_id,run_id), GiST(display_geom).
- run_shares: PK (org_id,run_id,grantee_user_id).
- run_commands: PK (org_id,run_id,command_id).

На исходных точках нет GiST. История читается по run, не по произвольной области мира.

## 6. Запись и жизненный цикл

### 6.1 Создание и команды

Начало записи требует успешного создания run онлайн; офлайн-старт нового run не входит в MVP. После создания устройство может буферизовать GPS и команды локально.

Клиент создаёт runId и commandId один раз и сохраняет до подтверждения. Повтор создания с тем же id и исходным payload возвращает существующий run; изменение исходного payload — конфликт. Идентификаторы удалённых run не переиспользуются: tombstone без координат хранится в пределах годового срока.

Допустимые команды: pause, resume, finish. Команда содержит expectedControlRevision и уникальный commandId. Проверка дубликата команды предшествует проверке expectedControlRevision. Повтор возвращает сохранённый ответ; новый конфликтующий переход — 409.

Команды из локальной очереди отправляются последовательно. После resume клиент увеличивает segment_id; после разрыва измерений также начинает новый сегмент. segment_id — метка группировки, не доказательство серверного времени паузы.

Автозавершение выполняется не позднее ближайшего цикла maintenance после created_at + 24 часа. finished_at устанавливается сервером один раз. Оно определяет окна догрузки/retention, но не используется как точная длительность реальной пробежки.

### 6.2 Транзакция ingestion

1. Проверить сессию, организацию, владение run и размер тела.
2. Проверить диапазоны координат, конечность чисел, seq > 0, segment_id ≥ 0, accuracy_m ≥ 0.
3. Начать READ COMMITTED; заблокировать runs через FOR UPDATE.
4. Проверить raw_state и сравнить существующие seq с каноническим payload.
5. Для новых точек проверить окно догрузки и лимит общего числа точек.
6. Если есть новые точки, увеличить data_revision один раз; вставить их с этой ingested_revision.
7. COMMIT, затем ACK.

Одинаковый ключ с другим исходным содержимым отклоняет всю пачку. received_at и ingested_revision не участвуют в сравнении клиентского payload. Один ON CONFLICT DO NOTHING недостаточен.

После закрытия окна догрузки подтверждаем точные повторы, пока исходные строки ещё доступны; новые точки отклоняем. После начала purging не обещаем распознать старый повтор — возвращаем RAW_HISTORY_UNAVAILABLE.

Пауза/finish не отклоняют ранее записанные точки только из-за текущего статуса. Окно догрузки регулируется серверным временем; оно не гарантирует достоверность заявленных устройством timestamps.

Время устройства сохраняем как исходное. Для live пригодности допускаем только recorded_at не старше 15 с и не более чем на 5 с впереди серверного времени. Нарушение этого условия не уничтожает офлайн-историю.

### 6.3 Гарантия сохранения

Локальный буфер в IndexedDB хранит измерение и seq до ACK конкретной пачки. Повтор — с backoff и jitter; постоянная ошибка 4xx не повторяется бесконечно.

ACK означает commit PostgreSQL при fsync=on и synchronous_commit=on. Это защищает от обычного сбоя процесса при исправном постоянном хранилище. Потеря диска/узла без реплики может потерять подтверждённые данные; резервное копирование имеет отдельный RPO. [PostgreSQL WAL](https://www.postgresql.org/docs/current/runtime-config-wal.html)

## 7. Обработка геоданных

Порядок трека определяется seq; recorded_at используется для интервалов. received_at не разрывает трек после офлайн-догрузки.

Допустимое ребро между соседними по seq точками требует:

- последовательных seq и одинакового segment_id;
- accuracy_m ≤ 30 у обеих точек;
- 0 < разница времени ≤ 10 с;
- геодезической скорости ≤ 12 м/с.

Пороги — параметры algorithm_version, не обещание точности GPS. Недопустимая точка/ребро не создаёт автоматического соединения через пропуск.

distance_m — сумма ST_Distance(a.geom::geography,b.geom::geography) допустимых рёбер, до упрощения. observed_duration_s — сумма их временных интервалов; не называем её moving time. Высоту не учитываем. [ST_Distance](https://postgis.net/docs/ST_Distance.html)

Сохраняем counts исходных точек, плохой точности и разрывов по причинам. При отсутствии допустимых рёбер дистанция 0 сопровождается insufficient_data.

Из допустимых цепочек строим MultiLineString. Одиночные точки не становятся фиктивными линиями. Для архива — Douglas–Peucker с начальным допуском около 5 м в локальной метрической проекции:

- части до 20 км по накопленной длине, с общей граничной точкой;
- локальная азимутальная эквидистантная проекция;
- упрощение с сохранением концов, обратное преобразование в 4326;
- нормализация/разделение при пересечении антимеридиана.

Это инженерное приближение для отображения, не строгая глобальная метрическая гарантия. Web Mercator не используется для точной дистанции. ST_Simplify измеряет tolerance в единицах входной SRS. [ST_Simplify](https://postgis.net/docs/ST_Simplify.html), [ST_Transform](https://postgis.net/docs/ST_Transform.html)

Полный пересчёт завершённых run запускается раз в минуту:

1. Прочитать точки и source revision в коротком REPEATABLE READ snapshot.
2. Рассчитать результат без удержания блокировки run.
3. При публикации заблокировать organization, затем run; сверить revision, состояние и отсутствие удаления.
4. Записать summary и увеличить archive_revision в одной транзакции.
5. При расхождении версии отбросить результат и повторить позже.

Все операции, которым нужны обе блокировки, соблюдают порядок organization → run. Ingestion блокирует только run и никогда затем не запрашивает organization lock.

## 8. Чтение, права и согласованность

Владелец читает свой run. Для чужого требуется активное membership и явный grant:

- can_read_live — незавершённый run, включая его текущий трек;
- can_read_history — история, сводка и архивные тайлы;
- изменение точек/статуса — только владелец;
- shares изменяет только владелец.

RLS включается на всех tenant-owned таблицах. Runtime-role не владелец, не superuser, без BYPASSRLS. Tenant/user context задаётся сервером transaction-local после аутентификации. API остаётся доверенной границей; клиент не подключается к PostgreSQL.

ACL применяется к точкам/сводкам также при прямом запросе, а не только при чтении runs. Политики проверяются интеграционно под реальной runtime-role. Maintenance использует отдельную ограниченную роль. [PostgreSQL RLS](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)

История: индексный проход по (org_id,run_id,seq), страницы до 1 000 точек. Для raw replay курсор содержит data_revision; изменение версии требует перезапуска чтения. Для live используется иной стабильный протокол из раздела 9.

Архивная область: ST_Intersects(display_geom,envelope4326), ACL и период до pagination. До 100 run на странице, курсор (started_at,id). Семантика — пересечение отображаемой упрощённой линии, не доказательство фактического нахождения в точке.

Текущие позиции в радиусе: доступные recording run → две последние точки через LATERAL → качество последнего ребра и свежесть → ST_DWithin(...::geography,...,radius_m). До 10 кандидатов; без пространственного индекса current positions. Не заменяем непригодную последнюю точку старой, выдавая её за свежую.

## 9. Live и восстановление

### 9.1 SSE состояния

Одна вкладка открывает один GET /api/orgs/{orgId}/live. Аутентификация — same-origin Secure/HttpOnly session cookie. State-changing HTTP защищены Origin/CSRF-проверкой; токены не размещаются в URL.

SSE: text/event-stream, private/no-store, отключённая proxy buffering, heartbeat каждые 15 с, HTTP/2 на внешнем входе. Нативный EventSource автоматически переподключается, но не создаёт durable replay. [SSE](https://html.spec.whatwg.org/multipage/server-sent-events.html)

Первое live.state — сразу. Затем общий backend-цикл раз в 2 с получает revisions, последние точки и актуальные права, группируя запросы. SSE-подключение не удерживает DB connection/транзакцию всё время.

Сообщение — полный компактный список доступных незавершённых run. При исчезновении run клиент убирает его из live-слоя. Если доступ к истории остался, отдельно загружает завершённый run.

При backpressure хранится только последнее ожидающее состояние на соединение; длительно заблокированное соединение закрывается. Число одновременных соединений ограничивается. Перед новой отправкой учитываем обнаруженные изменения прав и отменяем ещё не отправленное устаревшее состояние. Уже отправленные данные отозвать невозможно.

Позиция confirmed только при допустимом последнем ребре; при одной пригодной точке — unconfirmed; при плохой точности/времени — null. Возраст клиент рассчитывает относительно serverTime; потеря GPS отмечается даже при работающем SSE.

При position=null клиент может оставить ранее показанный маркер как явно устаревший last-known position, но не считать его текущим. При исчезновении run из разрешённого списка удаляются и текущие, и last-known данные этой пробежки.

### 9.2 Snapshot и changes

SSE сообщает dataRevision, но не несёт всю историю. Клиент синхронизирует только треки, которые отображает.

Initial live-track фиксирует R и выдаёт точки с ingested_revision ≤ R. Пагинация сортируется по seq; cursor подписан сервером, включает org/run/user, R, algorithmVersion, последнюю seq и срок действия 10 минут.

Changes(afterRevision=A) фиксирует T ≥ A. Изменяемые элементы:

- точки с A < ingested_revision ≤ T;
- их непосредственные существующие преемники в наборе на версии T.

Набор дедуплицируется и сортируется по seq. Для каждой записи сервер вычисляет predecessorSeq и connectFromPrevious по точкам с ingested_revision ≤ T. Это исправляет связь следующей точки при поздней вставке.

Все страницы фиксируют T и algorithmVersion; изменения после T не попадают в них. Snapshot в БД не удерживается между HTTP-запросами: воспроизводимость обеспечивается immutable точками и ingested_revision. На каждом запросе повторно проверяются ACL и raw_state.

После получения всех страниц клиент атомарно применяет upserts и продвигает локальную revision. При повторе применяются те же ключи; одновременно — одна синхронизация на run. SSE-версии, пришедшие во время загрузки, объединяются в последнюю целевую revision.

При истёкшем курсоре, новой algorithmVersion или потере локального состояния — новый snapshot. При finish право live прекращается; продолжение истории требует can_read_history. При purging/purged подробный трек недоступен.

run seq не является курсором изменений. Last-Event-ID не используется как обещание воспроизведения SSE. При сбое после DB commit следующая проверка состояния всё равно обнаружит новую revision.

## 10. Архивные тайлы и кэш

### 10.1 Генерация

XYZ, z=8…16; 0 ≤ x,y < 2^z. Ниже z8 слой скрыт; выше z16 — overzoom. На низком масштабе возможен переход к отдельным агрегатам в будущем.

Источник: опубликованные summaries, завершённые run, history ACL, абсолютный диапазон дат. Выдаётся последний опубликованный summary; если он отстаёт от data_revision из-за поздних точек, детали показывают pending recompute, а публикация новой сводки обновляет archive_revision.

PostGIS pipeline:

1. ST_TileEnvelope(z,x,y) в 3857.
2. Выбор кандидатов по расширенной области и GiST(display_geom) в 4326.
3. Фильтры доступа/периода.
4. Обрезка до допустимой Web Mercator-области, ST_Transform в 3857.
5. ST_AsMVTGeom с extent=4096, buffer=64, clip_geom=true.
6. Удаление пустых/выродившихся не-линейных результатов, ST_AsMVT.

Для selection margin=64/4096; в ST_AsMVTGeom передаются нерасширенные tile bounds. На антимеридиане split search envelope и при необходимости shift соседней world-copy перед clip. [ST_TileEnvelope](https://postgis.net/docs/ST_TileEnvelope.html), [ST_AsMVTGeom](https://postgis.net/docs/ST_AsMVTGeom.html)

MVT layer: runs. Свойство run_id — строковый UUID; не числовой feature ID. Личные имена и исходные GPS-данные не включаются. Один run может присутствовать в нескольких тайлах. [ST_AsMVT](https://postgis.net/docs/ST_AsMVT.html)

Пагинации и LIMIT 100 в MVT нет. Начальные предохранители: до 1 МиБ несжатого тайла, до 2 с SQL, максимум 2 параллельные генерации на процесс, очередь до 16 запросов. Превышение не маскируется усечённой геометрией: явная ошибка, метрика, предложение сузить период/приблизить карту.

### 10.2 Кэш и revision

LRU процесса: 32 МиБ бинарных данных, TTL 5 минут, single-flight для одного ключа. Ключ:
formatVersion / orgId / userId / archiveRevision / canonicalFilterHash / z/x/y.

Пустые тайлы кэшируются; ошибки и отказы доступа — нет. Membership и текущая archive_revision проверяются до чтения кэша, из БД. ACL-изменения и изменение revision атомарны.

При cache miss revision, ACL и геометрия читаются в согласованном snapshot. Запрос со старой revision получает 409 ARCHIVE_REVISION_CHANGED, а не исторический тайл. При конкурентном изменении авторизация имеет момент проверки; уже начатый/доставленный ответ нельзя ретроактивно отозвать.

Публикация/удаление summary, изменение archive grants, деактивация membership увеличивают organization archive_revision. Грубая инвалидация затрагивает все тайлы организации; для 10 пользователей это приемлемо.

HTTP тайлов: application/vnd.mapbox-vector-tile, Cache-Control: private, no-store. Mapbox может держать видимые тайлы в оперативной памяти. Готовые сетевые ответы обслуживает LRU; публичный CDN для них не используется.

Активный клиент проверяет archive metadata раз в 30 с; при возвращении на вкладку — сразу. При новой revision меняет URL шаблона через setTiles, при отзыве доступа очищает слой. TTL не является механизмом соблюдения 60 с. [Mapbox VectorTileSource](https://docs.mapbox.com/mapbox-gl-js/api/sources/#vectortilesource)

## 11. API-контракты

Базовый prefix: /api/orgs/{orgId}. Все даты — ISO 8601 UTC, координаты — longitude/latitude. Идентификатор пользователя берётся из сессии, не из тела запроса.

### 11.1 Общие типы

~~~ts
type UUID = string;
type Revision = string;
type Seq = string;
type Time = string;
type RunStatus = "recording" | "paused" | "finished";

interface RunView {
  runId: UUID; status: RunStatus;
  startedAt: Time; finishedAt: Time | null;
  dataRevision: Revision; controlRevision: Revision;
  rawState: "available" | "purging" | "purged";
  summary: null | {
    sourceRevision: Revision; algorithmVersion: string;
    distanceM: number; observedDurationS: number;
    qualityStats: Record<string, number>;
  };
}
interface PointInput {
  seq: Seq; segmentId: number; recordedAt: Time;
  longitude: number; latitude: number; accuracyM: number;
}
interface TrackPoint {
  seq: Seq; segmentId: number; recordedAt: Time;
  coordinates: [number, number]; accuracyM: number;
  predecessorSeq: Seq | null; connectFromPrevious: boolean;
}
interface TrackPage {
  fromRevision: Revision | null; // null для initial snapshot
  toRevision: Revision;
  algorithmVersion: string;
  upserts: TrackPoint[];
  nextCursor: string | null;
}
interface ApiError {
  error: { code: string; message: string; requestId: string;
    details?: Record<string, unknown> };
}
~~~

TypeScript не заменяет runtime-валидацию на обеих границах.

### 11.2 Запись и управление

| Метод и путь | Запрос | Успех |
|---|---|---|
| PUT /runs/{runId} | { startedAt } | 201 RunView; повтор 200 RunView |
| POST /runs/{runId}/commands | { commandId, type: pause/resume/finish, expectedControlRevision } | 200 { commandId, status, controlRevision, dataRevision, finishedAt } |
| POST /runs/{runId}/points | { points: PointInput[] } | 200 { dataRevision, insertedCount, duplicateCount } |
| DELETE /runs/{runId} | — | 204, каскадное удаление + archive revision |
| PUT /runs/{runId}/shares/{userId} | { canReadLive, canReadHistory } | 200 с сохранёнными boolean |
| DELETE /runs/{runId}/shares/{userId} | — | 204 |

POST points атомарен: при успехе все уникальные seq запроса сохранены или совпадают с существующими. Дубли внутри пачки нормализуются; конфликт содержания отклоняет пачку.

DELETE идемпотентен для владельца с учётом tombstone. Повторный PUT удалённого run — 410 RUN_DELETED.

### 11.3 Чтение

| Метод и путь | Параметры | Ответ |
|---|---|---|
| GET /runs | from, to, limit≤100, cursor | { items: RunView[], nextCursor } |
| GET /runs/{runId} | — | RunView |
| GET /runs/{runId}/points | cursor, limit≤1000 | { dataRevision, points: PointInput[], nextCursor } |
| GET /runs/{runId}/live-track | cursor, limit≤1000 | TrackPage |
| GET /runs/{runId}/live-track/changes | afterRevision или cursor, limit≤1000 | TrackPage |
| GET /runs/{runId}/track | mode=archive | GeoJSON Feature с MultiLineString/null, sourceRevision, algorithmVersion |
| GET /archive/runs | bbox, from, to, limit≤100, cursor | { items: RunView[], nextCursor } |
| GET /live/nearby | longitude, latitude, radiusM≤5000 | { serverTime, items: [{ runId, coordinates, recordedAt, distanceM }] } |

from/to задают полуинтервал по started_at. Для archive period максимум 366 дней. bbox: west,south,east,north; west>east означает пересечение антимеридиана. nearby использует только confirmed/fresh позиции.

Raw points endpoint выдаёт исходные данные только по history ACL/владению; live-track — незавершённые по live ACL либо завершённые по history ACL. Это позволяет догрузить финальное состояние, если право истории осталось.

### 11.4 SSE

GET /live → event: live.state, JSON:
~~~ts
interface LiveState {
  streamId: UUID; sequence: number; serverTime: Time;
  algorithmVersion: string;
  runs: Array<{
    runId: UUID; status: "recording" | "paused";
    dataRevision: Revision;
    position: null | {
      seq: Seq; coordinates: [number, number];
      recordedAt: Time; accuracyM: number;
      quality: "confirmed" | "unconfirmed";
    };
  }>;
}
~~~

streamId новый при подключении, sequence упорядочивает сообщения только этого соединения. При потере сессии соединение закрывается; клиент проверяет session endpoint и не запускает бесконечную авторизационную ошибку. Проверка истечения сессии выполняется и на живом соединении.

### 11.5 Tiles

GET /archive/metadata?from=...&to=...
~~~json
{
  "archiveRevision": "81",
  "filter": {"from": "2026-09-01T00:00:00Z", "to": "2026-10-01T00:00:00Z"},
  "tiles": ["/api/orgs/{orgId}/tiles/runs/{z}/{x}/{y}.mvt?revision=81&from=...&to=..."],
  "sourceLayer": "runs",
  "minzoom": 8,
  "maxzoom": 16
}
~~~

URL — шаблон; реальные значения orgId/filter выдаёт сервер. Revision и фильтр не предоставляют авторизацию.

GET /tiles/runs/{z}/{x}/{y}.mvt?revision=...&from=...&to=... → 200 бинарный MVT; пустой набор — корректный пустой MVT. Ошибки — JSON ApiError с соответствующим HTTP status. Frontend обрабатывает ошибки tile source и при revision mismatch обновляет metadata.

### 11.6 Ошибки

| Status | Коды и поведение |
|---|---|
| 400 | INVALID_REQUEST, INVALID_CURSOR; исправление запроса |
| 401 | AUTH_REQUIRED; восстановить сессию |
| 403 | ORG_ACCESS_DENIED; прекратить подписки организации |
| 404 | RUN_NOT_FOUND; также для недоступного конкретного run |
| 409 | POINT_CONFLICT, CONTROL_REVISION_CONFLICT, ACTIVE_RUN_EXISTS, UPLOAD_WINDOW_CLOSED, ARCHIVE_REVISION_CHANGED, HISTORY_REVISION_CHANGED, CURSOR_EXPIRED, ALGORITHM_CHANGED |
| 410 | RAW_HISTORY_UNAVAILABLE, RUN_DELETED |
| 413 | BATCH_TOO_LARGE |
| 422 | RUN_POINT_LIMIT, TILE_TOO_COMPLEX |
| 429 | RATE_LIMITED; учитывать Retry-After |
| 503 | DATABASE_UNAVAILABLE, TILE_BUSY, TILE_TIMEOUT; ограниченный retry с jitter |

Conflict/error details не содержат чужие точки. Авторизация проверяется раньше выдачи информации о retention и конфликтах объекта.

## 12. Retention, удаление, backups

Через 7 дней после finished_at maintenance проверяет закрытое upload window и актуальную summary. Под блокировкой run ставит raw_state=purging; новые raw-запросы получают 410, пересчёты из raw запрещены. Затем удаляет points ограниченными пачками и ставит purged. Повтор задачи безопасен.

Если summary не построена, удаление откладывается с алертом: семь дней — целевой срок, не жёсткое юридическое обещание. После purged доступны только summary и архивная геометрия; точный replay/пересчёт невозможен.

Через год удаляется run со связанными данными; archive_revision увеличивается. Явное удаление владельцем действует раньше и удаляет также локальные серверные кэши через смену версии ключей. Старые недоступные LRU entries вытесняются/истекают максимум через 5 минут.

Ежедневный зашифрованный backup вне хоста; retention 7 дней. Начальные цели аварийного восстановления: RPO ≤24 часа, RTO ≤4 часа, подлежат проверке restore drill. Бэкапы могут содержать удалённые данные до истечения срока; перед возвратом восстановленной БД в доступ необходимы повторное применение последующих удалений из отдельно сохраняемого журнала удаления и восстановление актуальных ограничений доступа.

Это отдельная эксплуатационная задача. Пока проверенного restore-процесса нет, сервис не заявляет соответствующий RPO/RTO достигнутым.

## 13. Развёртывание и эксплуатация

Локально: Docker Compose, PostgreSQL/PostGIS, NestJS, React, GPS-симулятор. Демо: один хост/регион, TLS reverse proxy, persistent DB volume, внешний backup. Backend и PostgreSQL имеют независимые resource limits.

Начальные пределы: DB pool 10 соединений на backend, максимум 2 одновременных tile-query, максимум 2 summary jobs. Длительные SSE не занимают pool slots. Запросы и фоновые задачи имеют timeouts. Лимиты уточняются измерениями, а не числом пользователей само по себе.

Продуктовая аутентификация подключается через проверенный identity provider; регистрация/восстановление пароля не реализуются собственным криптографическим протоколом. Для локальных интеграционных тестов — тестовые identity/session fixtures.

Graceful shutdown останавливает новые задачи/запросы, завершает короткие транзакции, закрывает SSE; после старта jobs находят незавершённую работу в БД.

## 14. Узкие места и развитие

| Узел | Риск | Сигнал | Следующий шаг |
|---|---|---|---|
| PostgreSQL write path | WAL, индексы, всплеск догрузок | commit p95, I/O, pool wait | batching, quotas; затем оценка очереди |
| Summary processing | Полные пересчёты больших run | revision lag, CPU | секционный расчёт/отдельные workers |
| Tile generation | Много геометрии в одном тайле | bytes, SQL p95, timeout | LOD, subdivision, projected index; затем pre-generation |
| Organization revision | Грубая инвалидация/горячая строка | miss ratio, lock wait | версии dataset/пользовательских scopes |
| Live reconciliation | Рост зрителей и ACL-запросов | cycle duration >2 с | commit notifications + периодическая сверка |
| Raw retention | DELETE/autovacuum не успевают | dead tuples, table growth | партиционирование после пересмотра ключей |
| Один сервер | Недоступность/потеря узла | health/backup failures | managed DB/реплика, несколько API |

Партиционирование по времени не добавляется механически: глобальная уникальность (org_id,run_id,seq) должна быть сохранена, а PostgreSQL требует учитывать ключ партиции в соответствующих unique constraints. Проектирование дедупликации потребуется пересмотреть.

При нескольких API общий tile-cache может стать Redis. Уведомления между экземплярами не заменяют восстановление по БД. Для обязательной обработки каждого события отдельными сервисами потребуется durable outbox; переход SSE → WebSocket этого не решает.

## 15. Проверка и критерии приёмки

### Корректность

- Повтор и конкурентный повтор пачки: одна строка на ключ.
- Commit успешен, ACK потерян: повтор безопасен.
- Одинаковый seq с другим payload: атомарный отказ.
- Порядок 41,43,42: исправляется ребро к 43.
- Changes pagination на фиксированной T не меняется от новых вставок.
- Конкурентные pause/resume, finish и GPS: контролируемые переходы.
- Точные повторы после upload window подтверждаются до raw purge.
- Summary старой revision не публикуется.
- Purge после сбоя продолжается, неполная история не пересчитывается.
- Удалённый run не воскресает от retry, summary job или восстановления backup.

### Геометрия

- Неподвижный GPS, известная дистанция, резкие повороты, выброс, clock rollback.
- Разрыв измерений отличается от задержки передачи.
- Упрощение не меняет сохранённую distance_m.
- Антимеридиан, полярное ограничение Web Mercator, соседние тайлы.
- Пустой/выродившийся трек имеет явное состояние качества.

### Доступ

- Cross-tenant чтение, запись, shares и cache hit.
- Обход API через SQL под runtime-role всё ещё ограничен RLS.
- can_read_live не открывает завершённую историю.
- Отзыв grant/membership проверяется в SSE, snapshots, changes, tiles.
- Нельзя получить чужие counts/ошибки существования через geo-запрос.

### Нагрузка
Обычный набор: 126 тыс. raw points, 3 650 summaries. Стресс: 3 млн raw points, 10 одновременных офлайн-пачек по 100 точек, 10 наблюдателей, pan/zoom bursts и concurrent summary job.

Начальные цели:

- ingestion HTTP p95 ≤500 мс без клиентской сети;
- свежий GPS → экран p95 ≤5 с;
- публикация summary → активная карта ≤60 с;
- стабильный объём LRU и SSE pending buffers;
- отсутствие starvation ingestion от tile jobs.

EXPLAIN (ANALYZE,BUFFERS) оценивает SQL; отдельно измеряем JSON/MVT bytes, сериализацию и frontend frame time. Маленький sequential scan не является ошибкой. Ни одна цель пока не подтверждена тестами.

Метрики: point commit latency, duplicates/conflicts, data age, live-cycle duration, SSE reconnects/backpressure, summary lag, tile bytes/time/hit ratio, pool wait, dead tuples, backup age, purge failures. В логах — requestId и технические идентификаторы, без GPS, payload, session tokens.

## 16. Порядок реализации

1. Основа: Compose, migrations, runtime/maintenance roles, session fixtures, organizations/memberships и RLS.
   Готово, когда cross-tenant integration tests проходят под runtime-role.
2. Вертикальный сценарий: create run → batch → повтор → history → finish; IndexedDB и симулятор.
   Готово, когда данные сохраняются после потери ответа и переподключения.
3. Track processing: edge rules, summary, revisions, late points, purge.
   Готово, когда геометрические fixtures и конкурентный пересчёт проверены.
4. Live: SSE state, snapshot/changes, reconnect, ACL revocation, React markers/track.
   Готово, когда соблюдается контракт восстановления и измерен live p95.
5. Archive tiles: MVT, границы мира, ACL, LRU, revision refresh.
   Готово, когда соседние тайлы корректны и неподвижная карта обновляется.
6. Эксплуатация: limits, метрики, нагрузка, restore drill и документация запуска.
   Готово, когда известны измеренные пределы и проверено восстановление.

Не начинаем с микросервисов или Redis. Первый демонстрируемый результат — одна надёжно записанная и восстановленная пробежка; инфраструктура добавляется по проверяемым требованиям.

## 17. Что уточнить в ходе реализации

- Фактические пороги GPS-качества и погрешность дистанции на реальных треках.
- Поведение выбранного браузера/устройства; для background tracking понадобится отдельный клиент.
- Точные версии runtime/PostGIS/Mapbox SDK: зафиксировать lockfiles/образы после smoke test.
- Провайдер, цена Mapbox и хостинга; бюджет пока проектный.
- Правила отображения очень плотных тайлов после измерения.
- Identity provider и проверенный процесс восстановления с журналом удалений.

Эти пункты не блокируют реализацию вертикального сценария, но не должны выдаваться за уже проверенные свойства системы.
