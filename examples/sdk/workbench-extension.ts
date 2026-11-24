import { defineTask, z } from "@themelios/models";

export default {
  tasks: [
    defineTask({
      id: "document.keywords",
      title: "Keywords",
      purpose: "Extract search terms from the supplied documents.",
      input: z.strictObject({ focus: z.string().nullable().default(null) }),
      output: z.strictObject({ keywords: z.array(z.string().min(1)) }),
      requirements: {
        minMaterials: 1,
        inputs: [{ mediaType: "text/*", needs: ["text"] }],
      },
      templates: {
        inline: true,
        user: "Extract distinctive keywords from the documents.{% if focus %} Focus on {{ focus }}.{% endif %}",
      },
    }),
  ],
};
