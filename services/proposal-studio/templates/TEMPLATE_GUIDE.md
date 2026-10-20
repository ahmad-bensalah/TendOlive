# How to prepare an OliveSoft template for the studio

The studio keeps only the design of a template: backgrounds, shapes, pictures and logos.
It deletes every text, then writes the agents' content where your texts were. These rules
describe what the importer (`template_importer.py`) reads, so the result looks like your design.

## The file
- **PowerPoint `.pptx`, 16:9** (13.33 × 7.5 in or 20 × 11.25 in). Export from Canva as PPTX.
- **Exactly 3 slides, in this order:**
  1. **Title slide** (cover).
  2. **Content slide**: the layout every content slide of the deck will use.
  3. **Thank-you slide** (closing).
  With more slides, the importer takes slide 1, slide 3 and the last one.
- Under 60 MB. Compress big photos (1920 px wide is enough).

## Colours and fonts
- Set the **theme colours** in PowerPoint (Design → Variants → Colours → Customise):
  - **Accent 1 = main brand colour.** It is used for table headers, bars and diagrams.
  - **Accent 2 = second colour.**
  - **Dark 1 / Light 1 = text and background colours.**
  Without theme colours, the importer guesses from the colours on the slides.
- **Text must contrast with the background.** Dark text on a light background, or white text
  on a dark background. When the contrast is too low, the importer forces white or near-black text.
- Fonts: use common ones (Montserrat, Poppins, Inter, Open Sans, Arial, Calibri). Rare fonts
  are replaced by a fallback.

## Slide 1: title
- Background: one full-slide picture or colour, plus decoration and the logo.
- **One big text box for the title** (the biggest font, in the upper half): write "Titre".
  Its position and size become the deck title's position.
- **One text box just below for the subtitle** (client name): write "Client".
- Keep decoration away from these two boxes.

## Slide 2: content (the most important one)
- **Header band**: a title text box in the **top 20 %** of the slide (write "Titre de la diapositive").
- **Body**: one large text box that covers the **whole area where content should go**
  (write "Contenu"). Make it big, at least about 2/3 of the slide width and half its height.
  Tables, bullets, cards and diagrams are placed inside this box.
- **Decoration on this slide must stay in the margins:** top 20 %, bottom 14 %, or the left/right
  6 % of the slide. Anything in the middle of the slide is removed, because it would sit under the
  content. A full-slide background picture is kept.
- **Keep the background calm and plain** behind the body box (a solid or very light colour, or a
  subtle gradient). The content (tables, text, diagrams) must stay readable on top of it.
- Logo: small, in a corner of the header or footer.

## Slide 3: thank-you
- Background and decoration as you like.
- **One big text box for the message** (write "Merci").
- Optional: a **square shape where the QR code should go**. Otherwise the QR goes in the centre.

## Avoid
- **Text drawn as pictures** (titles exported as images): wide, short pictures are treated as
  text and removed.
- Important decoration in the middle of the content slide.
- Busy photos behind the content area.
- Charts, SmartArt and videos: they are not imported.

## After you add it
Drop the file in `templates/inbox/` and click **Recharger** in the "Modèles" section. To force
another content slide, add `<file name>.meta.json` next to it with `{"contentSlideIndex": 1}`
(0 = first slide).
