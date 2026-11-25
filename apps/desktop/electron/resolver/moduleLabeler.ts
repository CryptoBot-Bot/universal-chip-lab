/**
 * 5b: what is each identifier? One offline question to the model per batch of identifiers —
 * recorded bytes in, proposals out. Nothing here can reach a car: no tools, no device.
 */
import Anthropic from "@anthropic-ai/sdk";

import { LABEL_KINDS } from "@ecu/vehicle-db";

import { explorerModel } from "./moduleExplorer";
import { getApiKey } from "../settings";

export const LABEL_SYSTEM = `You name the diagnostic identifiers of one control module from bytes that were recorded on the real car. You work offline: nothing is sent to the car, and you cannot ask for more.

Each line is one identifier the module answers: its request (22 xxxx = UDS data identifier, 21 xx = KWP local identifier, 1A xx = KWP identification), the session it answered in, the number of data bytes, and the data read in different states of the car (two reads per state; a single value means both reads were equal). Data bytes are counted from 0, after the positive-response header. Text is shown when the bytes are printable. "X" bytes are a masked vehicle identification number.

For every identifier give: a short, specific name ("turbine speed", not "live data block" — if you cannot be specific, the kind is unknown), a kind, a confidence, one short reason, and the numbers inside it that you can justify.

Kinds:
- identification: part numbers, versions, serial numbers, dates, VIN, supplier, variant codes — fixed for the unit
- coding: configuration / adaptation that is fixed until someone changes it
- live: a measurement
- state: a status, flags, a mode, switch positions
- counter: something that counts or times
- unknown: you cannot tell. This is a correct and useful answer — most identifiers of a module without its data file are unknown.

Values: offset and length in bytes (1–4, big-endian), signed or not, physical = raw × factor + add, and the unit. For identifiers whose bytes change, give your best hypotheses, up to 8 values: what could this field be in this kind of module, given how it behaves between the states of the car? A hypothesis costs nothing — every one is tested afterwards by code against measurements you are not shown, and wrong ones are thrown away; mark them low. Say plainly what the field would be ("engine speed", "supply voltage terminal 30", "turbine speed", "transmission oil temperature") and use the unit of that quantity. For identifiers that never change, give a value only when a documented scheme supports it. Do not bend a factor to make a number look right: use the scales such modules really use.

Confidence: high = a documented scheme or the bytes leave no doubt; medium = the bytes support it well; low = a plausible reading. Keep the reason under 20 words. Return exactly one entry for each identifier you were given, with its id exactly as shown, and no others.`;

export const LABEL_SCHEMA = {
  type: "object", additionalProperties: false, required: ["labels"],
  properties: {
    labels: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["id", "name", "kind", "confidence", "why", "values"],
        properties: {
          id: { type: "string" }, name: { type: "string" }, kind: { type: "string", enum: LABEL_KINDS },
          confidence: { type: "string", enum: ["low", "medium", "high"] }, why: { type: "string" },
          values: {
            type: "array",
            items: {
              type: "object", additionalProperties: false, required: ["name", "offset", "length", "signed", "factor", "add", "unit"],
              properties: { name: { type: "string" }, offset: { type: "integer" }, length: { type: "integer" }, signed: { type: "boolean" }, factor: { type: "number" }, add: { type: "number" }, unit: { type: "string" } },
            },
          },
        },
      },
    },
  },
} as const;

export interface LabelAnswer { labels: unknown[]; tokensIn: number; tokensOut: number; model: string }

export async function askLabels(content: string): Promise<LabelAnswer> {
  const apiKey = getApiKey();
  if (!apiKey || !apiKey.trim()) throw new Error("No Anthropic API key set. Open Settings and paste your key to label a module.");
  const client = new Anthropic({ apiKey });
  const model = explorerModel();
  const response = await client.messages.stream({
    model, max_tokens: 64000, thinking: { type: "adaptive" }, system: LABEL_SYSTEM,
    output_config: { format: { type: "json_schema", schema: LABEL_SCHEMA as unknown as Record<string, unknown> } },
    messages: [{ role: "user", content }],
  }).finalMessage();
  if (response.stop_reason === "refusal") throw new Error("The model declined this request.");
  if (response.stop_reason === "max_tokens") throw new Error(`The labels ran out of room (${response.usage.output_tokens} output tokens).`);
  const text = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  if (!text) throw new Error("The model returned no labels.");
  const parsed = JSON.parse(text.text) as { labels?: unknown[] };
  return { labels: Array.isArray(parsed.labels) ? parsed.labels : [], tokensIn: response.usage?.input_tokens ?? 0, tokensOut: response.usage?.output_tokens ?? 0, model };
}
