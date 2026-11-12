/**
 * Spanish "why it matters" and "requested action" text per rule
 * (engine review §5: one action list per ruleId, not per rootCause). The
 * root-cause table is only the fallback for rules without an entry.
 * Never state that an opening in structure is approved: always "sujeto a
 * aprobación del calculista".
 */
import type { RootCause } from "../rules/schemas";

export interface ActionContext {
  /** Responsible discipline. */
  resp: string;
  /** Group of the responsible discipline (ARQ, EST, MEP…). */
  respGroup: string;
  /** Secondary / consulted discipline. */
  other?: string;
}

export interface RuleText {
  why: string;
  actions: (ctx: ActionContext) => string[];
}

const fixed = (...xs: string[]) => () => xs;

export const RULE_TEXT_ES: Readonly<Record<string, RuleText>> = {
  "EST-001": { why: "Los pilares no admiten pasadas: compromete la capacidad estructural.", actions: fixed("Desviar el trazado fuera del pilar.", "Si no hay espacio, rodear por el entretecho o el muro contiguo.", "Llevar a reunión si el desvío afecta otras redes.") },
  "EST-002": { why: "La pendiente limita el desvío de la red gravitacional; una pasada en la estructura requiere calculista.", actions: fixed("Revisar trazado y cotas manteniendo la pendiente mínima.", "Si no hay alternativa, solicitar pasada a EST indicando posición y diámetro.", "Escalar a reunión si cambia la pendiente de la red.") },
  "EST-003": { why: "Una pasada no planificada en losa postensada puede cortar cables: debe coordinarse antes de hormigonar.", actions: fixed("Confirmar ubicación y medida de la pasada.", "Coordinar con EST la posición respecto del trazado de cables y modelarla.", "Si no es posible, desviar fuera de la losa postensada.") },
  "EST-004": { why: "Un ducto de esta sección no admite pasada en viga; tal como está modelado bloquea el montaje.", actions: fixed("Verificar cota y offset de los tramos.", "Bajar los tramos bajo las vigas o cambiar la sección (más baja y ancha) dentro del entretecho.", "Si no hay altura, llevar a reunión con ARQ (cota de cielo).") },
  "EST-005": { why: "Una pasada de este tamaño en viga solo es posible con aprobación del calculista (tercio central, Ø ≤ h/3).", actions: fixed("Desviar bajo la viga.", "Si no es posible, solicitar pasada a EST con posición y diámetro.", "Escalar a reunión si afecta la altura libre.") },
  "EST-006": { why: "La instalación interfiere la viga; toda pasada en viga requiere calculista.", actions: fixed("Desviar bajo o alrededor de la viga.", "Si no es posible, solicitar pasada a EST.") },
  "EST-007": { why: "Los muros de hormigón armado resisten el sismo: toda pasada debe quedar aprobada y modelada.", actions: fixed("Confirmar medida y ubicación de la pasada.", "Solicitar a EST que la modele en el muro.", "Si es posible, desviar fuera del muro.") },
  "EST-008": { why: "Las pasadas en fundaciones deben definirse antes de excavar.", actions: fixed("Revisar cotas de la red enterrada.", "Definir la pasada con EST antes de la excavación.") },
  "EST-009": { why: "Sin la pasada en el modelo EST no queda en planos de moldaje y se perfora después del hormigonado.", actions: ({ other }) => [`${other ?? "La especialidad"} confirma medida y ubicación de cada pasada.`, "EST modela las pasadas en las losas y las incorpora al plano de pasadas."] },
  "EST-010": { why: "Un tramo horizontal embebido en la losa indica un error de cota o de nivel de referencia.", actions: fixed("Verificar nivel de referencia y offset.", "Bajar el tramo al entretecho.") },
  "EST-011": { why: "Sin orientación no se sabe si falta una pasada (cruce vertical) o hay un error de cota (tramo embebido).", actions: fixed("Revisar en el visor si es un cruce vertical o un tramo embebido.", "Si es vertical, confirmar la pasada con EST; si es horizontal, corregir la cota.") },
  "AE-001": { why: "El vano estructural no coincide con la puerta o ventana; mover un vano en muro HA requiere calculista.", actions: fixed("Ajustar la puerta o ventana al vano de EST.", "Si el vano debe cambiar, solicitar la modificación a EST.") },
  "AE-002": { why: "La viga queda bajo la cota de cielo: afecta altura libre y terminaciones.", actions: fixed("Bajar el cielo o generar cajón/plafón bajo la viga.", "Revisar la altura libre resultante con el proyecto aprobado.") },
  "AE-004": { why: "Posible desfase de ejes o espesores entre ARQ y EST.", actions: fixed("Revisar ejes y espesores del elemento.", "Ajustar el modelo para que no se superponga con la estructura.") },
  "AE-005": { why: "La fachada interfiere la estructura: afecta anclajes y holgura de montaje.", actions: fixed("Revisar canto de losa, anclajes y holgura.", "Coordinar el detalle con EST y el fachadista.") },
  "AE-006": { why: "La escalera de ARQ interfiere la estructura: posible duplicado o cotas incompatibles.", actions: fixed("Verificar si duplica la escalera estructural.", "Corregir cotas o huella con EST.") },
  "MA-001": { why: "Compromete la altura libre de la vía de evacuación.", actions: fixed("Desviar fuera de la caja de escalera.") },
  "MA-002": { why: "Los vanos no se mueven por instalaciones.", actions: fixed("Desviar sobre el dintel o rodear el vano.") },
  "MA-003": { why: "Toda pasada por fachada afecta estanqueidad y garantía del sistema.", actions: fixed("Desviar fuera de la fachada.", "Si es inevitable, definir el detalle con el fachadista.") },
  "MA-005": { why: "La instalación queda bajo la cota de cielo.", actions: fixed("Subir la instalación en el entretecho.", "Si no hay altura, ARQ evalúa bajar el cielo o hacer cajón.") },
  "MA-006": { why: "La pasada por un muro resistente al fuego requiere sello certificado de igual resistencia.", actions: fixed("Definir la pasada con sello cortafuego certificado (o compuerta en ductos).", "Modelar la pasada y el sello.") },
  "MA-007": {
    why: "Una pasada de este tamaño en tabique requiere vano con refuerzo de perfilería.",
    actions: ({ respGroup }) => respGroup === "ARQ"
      ? ["Incorporar el vano con refuerzo de perfilería en el tabique.", "Confirmar medida y ubicación con la especialidad."]
      : ["Confirmar medida y ubicación de la pasada.", "Solicitar a ARQ el vano con refuerzo de perfilería (ARQ lo incorpora en su modelo)."],
  },
  "MA-008": { why: "El equipo o terminal se incrusta en el muro.", actions: fixed("Reubicar o confirmar que va embutido con nicho.") },
  "MA-009": { why: "Una pasada por cubierta requiere detalle de impermeabilización.", actions: fixed("Si es salida prevista, ARQ incorpora el detalle de impermeabilización.", "Si no, desviar.") },
  "MA-010": { why: "No está claro si el piso es la losa real (falta pasada) o una terminación.", actions: fixed("Verificar en el visor el tipo de piso.", "Si es losa, confirmar la pasada; si es terminación, corregir el modelo.") },
  "MA-011": { why: "El mobiliario fijo no se mueve fácilmente.", actions: fixed("Confirmar si el mobiliario es fijo.", "Desviar la instalación o reubicar el mueble.") },
  "MA-012": { why: "La baranda es un elemento de seguridad.", actions: fixed("Desviar la instalación.") },
  "MA-013": { why: "Sin la resistencia al fuego informada no se sabe si la pasada requiere sello cortafuego.", actions: fixed("Informar la resistencia al fuego de los muros afectados en el modelo.", "Si el muro sectoriza, la pasada requiere sello certificado; si no, es pasada estándar.") },
  "MM-001": { why: "Cruce entre redes gravitacionales: decidir qué red cede pendiente requiere ambas especialidades.", actions: fixed("Estudiar cotas y pendientes de ambas redes en conjunto.", "Decidir en reunión qué red se modifica.") },
  "MM-002": { why: "La red gravitacional no se desvía libremente: la otra instalación cede.", actions: fixed("Desviar la instalación bajo o sobre la red gravitacional.") },
  "MM-003": { why: "Debe mantenerse la separación reglamentaria entre gas y electricidad (DS 66 SEC / RIC, como referencia).", actions: fixed("Desplazar la canalización para cumplir la separación.", "Verificar la separación resultante en el modelo.") },
  "MM-004": { why: "Red de incendio: sistema de seguridad, se resuelve con prioridad.", actions: fixed("Desviar el tramo según la jerarquía de desplazamiento.") },
  "MM-005": { why: "Los equipos se ubican por layout de sala técnica: la red se desvía.", actions: fixed("Desviar la red alrededor del equipo.") },
  "MM-006": { why: "Dos equipos ocupan el mismo espacio.", actions: fixed("Revisar el layout de la sala técnica en reunión.") },
  "MM-007": { why: "Falta holgura para la aislación.", actions: fixed("Separar las redes lo necesario para la aislación.") },
  "MM-008": { why: "El conduit es lo más flexible de la red.", actions: fixed("Desviar el conduit.") },
  "MM-009": { why: "Los terminales siguen el plano de cielo aprobado.", actions: fixed("Desviar la red fuera del terminal.") },
  "MM-010": { why: "Dos redes ocupan el mismo espacio; se resuelve con la jerarquía de desplazamiento.", actions: fixed("Desviar los tramos de la red que se desplaza.", "Si no hay espacio, definir niveles por especialidad en el entretecho.", "Llevar a reunión si afecta a otras redes.") },
  "INC-001": { why: "El elemento obstruye la descarga del rociador: zona sin cobertura (criterio NFPA 13, como referencia).", actions: fixed("Reubicar los rociadores fuera de la obstrucción o agregar rociadores bajo ella.", "Verificar si la obstrucción puede desplazarse.") },
  "ELV-001": { why: "El shaft de ascensor es de uso exclusivo.", actions: fixed("Retirar la instalación del shaft.") },
  "SEI-001": { why: "El cruce de una junta sísmica requiere unión flexible y soportación (NCh 3357, como referencia).", actions: fixed("Definir unión flexible o loop sísmico.", "Definir el detalle con EST.") },
  "CLR-001": { why: "La zona de mantención queda invadida por la estructura, que no se mueve.", actions: fixed("Reubicar el equipo para despejar la zona.") },
  "CLR-002": { why: "La zona de mantención u operación del equipo debe quedar libre.", actions: fixed("Despejar la zona de mantención.") },
  "TOL-002": { why: "La separación es menor que la holgura exigida para el par de disciplinas.", actions: fixed("Desplazar el elemento hasta cumplir la holgura.") },
  "TOL-006": { why: "La canalización supera 1/3 del espesor del elemento estructural (o no hay espesor informado).", actions: fixed("Redistribuir la canalización.", "Si no es posible, solicitar aprobación al calculista.") },
  "DUP-001": { why: "El modelo duplicado genera interferencias falsas que ocultan problemas reales.", actions: fixed("Dejar una sola copia del archivo en el conjunto de modelos.", "Publicar antes del próximo corte.") },
  "DUP-002": { why: "Cada elemento choca consigo mismo y genera interferencias falsas.", actions: fixed("Dejar una sola vista 3D por archivo en la vista de coordinación.") },
  "DUP-003": { why: "Las instancias duplicadas inflan cubicaciones y generan interferencias falsas.", actions: fixed("Eliminar las instancias sobrantes.") },
  "DUP-004": { why: "La copia de elementos de otra disciplina oculta los problemas reales.", actions: fixed("Eliminar la copia y vincular el modelo de origen.") },
  "DUP-005": { why: "Genera interferencias falsas que ocultan problemas reales y duplica cubicaciones.", actions: fixed("Eliminar los muros HA del modelo ARQ y vincular el modelo EST.", "Modelar solo revestimientos como muros delgados adosados.") },
  "DUP-006": { why: "Genera interferencias falsas y duplica cubicaciones.", actions: fixed("Eliminar las losas HA del modelo ARQ y vincular el modelo EST.", "Modelar solo pavimentos y sobrelosas.") },
  "NI-001": { why: "No se puede evaluar un modelo genérico sin saber qué representa.", actions: fixed("Recategorizar el elemento con la categoría Revit correcta o declarar su función.") },
  "NI-002": { why: "Un elemento referencial no permite coordinar con seguridad.", actions: fixed("Confirmar si representa espacio real reservado y modelarlo con el nivel de detalle requerido.") },
  "HYG-003": { why: "Es un conflicto de secuencia (4D), no de diseño.", actions: fixed("Revisar contra el programa y el plan de faenas.") },
  "HYG-004": { why: "Sin propiedades indexadas no se puede clasificar.", actions: fixed("Verificar la indexación de propiedades del modelo.") },
  "DEF-999": { why: "Ninguna regla específica cubre este caso.", actions: fixed("Revisar en el visor y definir la acción en reunión.") },
};

export const ROOT_CAUSE_TEXT_ES: Readonly<Record<RootCause, RuleText>> = {
  routing_conflict: { why: "Las instalaciones ocupan el mismo espacio.", actions: fixed("Desviar el trazado fuera del elemento interferido.") },
  missing_opening: { why: "Falta la pasada modelada.", actions: fixed("Confirmar medida y ubicación de la pasada.", "Modelarla en el elemento atravesado.") },
  design_coordination: { why: "Los diseños de las especialidades se contradicen.", actions: fixed("Revisar la solución con la especialidad consultada.", "Proponer una alternativa de trazado o de diseño.") },
  modeling_error: { why: "Error de geometría en el modelo.", actions: fixed("Corregir nivel de referencia, offset o espesores.") },
  duplicate_model: { why: "Contenido duplicado en el conjunto de modelos.", actions: fixed("Eliminar el contenido duplicado y vincular el modelo de origen.") },
  model_hygiene: { why: "Elementos que no deberían estar en la prueba.", actions: fixed("Corregir el modelo o el set de búsqueda.") },
  lod_mismatch: { why: "Nivel de desarrollo insuficiente para coordinar.", actions: fixed("Declarar la función del elemento o recategorizarlo.") },
  outdated_model: { why: "El modelo puede estar desactualizado.", actions: fixed("Republicar el modelo y confirmar si la interferencia persiste.") },
  not_applicable: { why: "No requiere cambio de diseño.", actions: fixed("Confirmar el cierre.") },
};
