## Qué cambia
<!-- Una o dos líneas: qué y dónde (app, agente de la app, motor, reglas, docs). -->

## Por qué
<!-- Pedido del coordinador, bug, mejora. Enlaza el issue si existe. -->

## Cómo probarlo
<!-- Pasos en modo demo (npm run demo) o fixtures. Nunca con datos de un proyecto real. -->

## Checklist
- [ ] `npm run typecheck`, `npm test` y `npm run check` pasan
- [ ] Si cambié `agent-runtime/`: `npx tsx scripts/eval-agent.ts --self-test`
- [ ] Sin secretos, `.env`, datos de proyecto, datos personales ni rutas `C:\Users\<nombre>`
- [ ] No edité `rules/` a mano (las reglas se publican desde la app)
- [ ] **Toca seguridad** (aprobaciones, passkeys, escritura en ACC, permisos del agente, datos): sí / no — si es sí, explica
