# Deterministic GPS fixtures

`@running-tracker/fixtures` is the reusable P04.4 simulation core. It provides:

- a seeded GPS route generator with no wall-clock or network dependency;
- an explicitly advanced virtual clock with deterministic FIFO timer ordering;
- normal, duplicate, reordered, delayed-batch, dropped-response, clock-jump, and GPS-spike scenarios;
- a replay function that emits capture and upload-attempt events through the virtual clock.

The dropped-response scenario describes the expected transport outcome (`drop-after-commit`) for a harness. It does not inject faults into the API; that server-side test capability remains P04.5.

All generated points pass the shared canonical `PointInput` runtime contract. A seed and UTC start instant fully determine the output.
