from __future__ import annotations

from pathlib import Path

from docx import Document


DOCX = Path("/Users/renke/毕设/中期答辩/任科中期报告_0629_新框架版.docx")


def main() -> None:
    doc = Document(str(DOCX))
    for section in doc.sections:
        for footer in (section.footer, section.first_page_footer, section.even_page_footer):
            for para in footer.paragraphs:
                for run in para.runs:
                    if "39" in run.text:
                        run.text = run.text.replace("39", "19")
    doc.save(str(DOCX))
    print(DOCX)


if __name__ == "__main__":
    main()
