import OpenAI from "openai";
import { WebSocket } from "ws";
import {
  CustomLlmResponse,
  ReminderRequiredRequest,
  ResponseRequiredRequest,
} from "../types";

const beginSentence = `Hey there, I’m Julia from Field Routes, how can I help you today?`;

export class CallingAgent {
  private client: OpenAI;
  private thread: OpenAI.Beta.Threads.Thread;
  private run: OpenAI.Beta.Threads.Run;

  constructor() {
    this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  // First sentence requested
  async BeginMessage(ws: WebSocket) {
    this.thread = await this.client.beta.threads.create();

    const res: CustomLlmResponse = {
      response_id: 0,
      end_call: false,
      content: beginSentence,
      content_complete: true,
      response_type: "response",
    };

    ws.send(JSON.stringify(res));
  }

  private async PreparePrompt(
    request: ResponseRequiredRequest | ReminderRequiredRequest,
  ) {
    // Cancel the previous run
    try {
      let current_runs = await this.client.beta.threads.runs.list(
        this.thread.id,
      );

      for await (const run of current_runs) {
        await this.client.beta.threads.runs.cancel(this.thread.id, run.id);
      }
    } catch (err) {
      console.error("Error in cancelling run: ");
    }

    try {
      if (request.interaction_type == "reminder_required") {
        await this.client.beta.threads.messages.create(this.thread.id, {
          role: "user",
          content:
            "(Now the user has not responded in a while, you would say:)",
        });
      } else if (request.interaction_type == "response_required") {
        await this.client.beta.threads.messages.create(this.thread.id, {
          role: "user",
          content: request.transcript.at(-1).content,
        });
      }
    } catch (err) {
      console.error("Error in adding to thread run: ");
    }
  }

  async DraftResponse(
    request: ResponseRequiredRequest | ReminderRequiredRequest,
    ws: WebSocket,
  ) {
    // If there are function call results, add it to prompt here.
    await this.PreparePrompt(request);

    try {
      const events = await this.client.beta.threads.runs.create(
        this.thread.id,
        {
          assistant_id: process.env.OPENAI_ASSISTANT_ID,
          stream: true,
        },
      );

      for await (const event of events) {
        if (event.event == "thread.run.created") {
          this.run = event.data;
        } else if (event.event == "thread.message.delta") {
          let delta = event.data.delta.content[0];

          if (delta.type == "text") {
            // Remove the annotation from the delta
            let deltaText = delta.text.value;
            let deltaAnnotation = delta.text.annotations;

            if (deltaAnnotation != undefined) {
              for (let i = 0; i < deltaAnnotation.length; i++) {
                deltaText = deltaText.replace(deltaAnnotation[i].text, "");
              }
            }

            deltaText = deltaText.replaceAll("*", "");

            const res: CustomLlmResponse = {
              response_type: "response",
              response_id: request.response_id,
              content: deltaText,
              content_complete: false,
              end_call: false,
            };

            ws.send(JSON.stringify(res));
          }
        }
      }
    } catch (err) {
      console.error("Error in gpt stream: ", err);
    } finally {
      const res: CustomLlmResponse = {
        response_type: "response",
        response_id: request.response_id,
        content: "",
        content_complete: true,
        end_call: false,
      };

      ws.send(JSON.stringify(res));
    }
  }
}
