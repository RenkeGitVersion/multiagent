from __future__ import annotations

from pathlib import Path

from docx import Document


DOCX = Path("/Users/renke/毕设/中期答辩/任科中期报告_0629_新框架版.docx")


def main() -> None:
    doc = Document(str(DOCX))
    for table in list(doc.tables):
        if not table.rows:
            continue
        header = [cell.text.strip() for cell in table.rows[0].cells]
        if header[:3] == ["输入信息", "作用", "示例"]:
            table._element.getparent().remove(table._element)
            break
    doc.save(str(DOCX))
    print(DOCX)


if __name__ == "__main__":
    main()
