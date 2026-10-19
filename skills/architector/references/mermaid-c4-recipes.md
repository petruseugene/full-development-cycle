# Mermaid C4 Recipes

Three copy-pasteable Mermaid blocks for the C4 levels we draw most often. All
three describe the same example system — **TimeOff**, an internal time-off
request app — so you can see how a single domain decomposes from system
context down to a single container's components.

Render in any Mermaid 10+ environment. Keep each diagram below ~30 lines: if
it grows past that, you are mixing levels.

## C4Context — system in its world

Reach for `C4Context` first. It shows **who** uses the system and **what**
external systems it touches. No internal structure. One box per system.

```mermaid
C4Context
    title System Context — TimeOff

    Person(employee, "Employee", "Requests time off, views balance.")
    Person(manager, "Manager", "Approves or rejects requests for direct reports.")

    System(timeoff, "TimeOff", "Internal app for requesting and approving leave.")

    System_Ext(hris, "HRIS", "System of record for employees, balances, accruals.")
    System_Ext(email, "Email Gateway", "Delivers approval and reminder emails.")

    Rel(employee, timeoff, "Submits requests, checks balance", "HTTPS")
    Rel(manager, timeoff, "Reviews and approves requests", "HTTPS")
    Rel(timeoff, hris, "Reads employee + balance data", "REST/JSON")
    Rel(timeoff, email, "Sends notifications", "SMTP")

    UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")
```

## C4Container — inside the system

Use `C4Container` to zoom into one system. Wrap the internals in a
`System_Boundary`. Containers are independently deployable units (apps, APIs,
databases, queues). Use `ContainerDb` for stores.

```mermaid
C4Container
    title Containers — TimeOff

    Person(employee, "Employee")
    Person(manager, "Manager")
    System_Ext(hris, "HRIS", "Employees, balances")

    System_Boundary(timeoff, "TimeOff") {
        Container(web, "Web App", "React + Vite", "SPA served to browsers.")
        Container(api, "Request API", "Node.js / Fastify", "Request lifecycle, approvals, auth.")
        Container(worker, "Notifier Worker", "Node.js", "Sends approval and reminder emails.")
        ContainerDb(db, "Requests DB", "PostgreSQL", "Requests, approvals, audit log.")
        ContainerDb(queue, "Job Queue", "Redis Streams", "Pending notifications.")
    }

    Rel(employee, web, "Uses", "HTTPS")
    Rel(manager, web, "Uses", "HTTPS")
    Rel(web, api, "Calls", "JSON/HTTPS")
    Rel(api, db, "Reads/writes", "SQL/TCP")
    Rel(api, queue, "Enqueues notifications", "RESP")
    Rel(worker, queue, "Consumes jobs", "RESP")
    Rel(api, hris, "Fetches employee + balance", "REST/JSON")
    Rel(worker, hris, "Resolves recipient details", "REST/JSON")

    UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")
```

## C4Component — inside one container

Use `C4Component` to show the **internal structure of a single container**.
Below: the Request API. Components are classes, modules, or packages — not
deploy units. Show internal `Rel`s; collapse external systems to a single box.

```mermaid
C4Component
    title Components — Request API (TimeOff)

    Container(web, "Web App", "React")
    ContainerDb(db, "Requests DB", "PostgreSQL")
    ContainerDb(queue, "Job Queue", "Redis Streams")
    System_Ext(hris, "HRIS")

    Container_Boundary(api, "Request API") {
        Component(router, "HTTP Router", "Fastify", "Routes, validation, auth middleware.")
        Component(reqsvc, "Requests Service", "TypeScript", "Submit, cancel, list requests.")
        Component(apprsvc, "Approvals Service", "TypeScript", "Approve / reject, policy checks.")
        Component(hrisclient, "HRIS Client", "TypeScript", "Cached reads of employees + balances.")
        Component(notifier, "Notifier Publisher", "TypeScript", "Pushes notification jobs to queue.")
    }

    Rel(web, router, "JSON/HTTPS")
    Rel(router, reqsvc, "delegates submit/list")
    Rel(router, apprsvc, "delegates approve/reject")
    Rel(reqsvc, hrisclient, "checks balance")
    Rel(apprsvc, hrisclient, "checks reporting line")
    Rel(reqsvc, db, "reads/writes", "SQL")
    Rel(apprsvc, db, "reads/writes", "SQL")
    Rel(apprsvc, notifier, "emits ApprovalDecided")
    Rel(notifier, queue, "XADD", "RESP")
    Rel(hrisclient, hris, "REST/JSON")
```

