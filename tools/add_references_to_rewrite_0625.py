from __future__ import annotations

from pathlib import Path
from docx import Document
from docx.oxml import OxmlElement


DOCX = Path("/Users/renke/毕设/中期答辩/任科中期报告_0625_重写版.docx")

REFS = [
    "Heather Suzanne Woods. 2018. Asking more of Siri and Alexa: Feminine persona in service of surveillance capitalism. Critical Studies in Media Communication 35, 4 (2018), 334-349.",
    "Jiangjie Chen, Xintao Wang, Rui Xu, Siyu Yuan, Yikai Zhang, Wei Shi, Jian Xie, Shuang Li, Ruihan Yang, Tinghui Zhu, et al. 2024. From persona to personalization: A survey on role-playing language agents. arXiv preprint arXiv:2404.18231 (2024).",
    "Michael Braun, Anja Mainz, Ronee Chadowitz, Bastian Pfleging, and Florian Alt. 2019. At your service: Designing voice assistant personalities to improve automotive user interfaces. In Proceedings of the 2019 CHI Conference on Human Factors in Computing Systems. ACM, Glasgow, Scotland, UK, 1-11.",
    "Jessica Van Brummelen, Maura Kelleher, Mingyan Claire Tian, and Nghi Nguyen. 2023. What Do Children and Parents Want and Perceive in Conversational Agents? Towards Transparent, Trustworthy, Democratized Agents. In Proceedings of the 22nd Annual ACM Interaction Design and Children Conference. ACM, Chicago, IL, USA, 187-197.",
    "Nicole Meng-Schneider, Rabia Yasa Kostas, Kami Vaniea, and Maria K Wolters. 2023. Multi-User Smart Speakers-A Narrative Review of Concerns and Problematic Interactions. In Extended Abstracts of the 2023 CHI Conference on Human Factors in Computing Systems. ACM, Hamburg, Germany, 1-7.",
    "Nima Zargham, Michael Bonfert, Robert Porzel, Tanja Doring, and Rainer Malaka. 2021. Multi-agent voice assistants: An investigation of user experience. In Proceedings of the 20th International Conference on Mobile and Ubiquitous Multimedia. ACM, Leuven, Belgium, 98-107.",
    "Amazon Jeff Bezos, CEO. 2025. Multi-Agent Design Guide. https://developer.amazon.com/en-US/alexa/voice-interoperability/design-guide. Accessed: 2025-05-05.",
    "Wang, W., Lu, Z., Yuan, T., Fang, K., & Zhang, Y. (2025). In-vehicle multi-personality voice interaction: insights from Chinese automotive market on how dynamic personality influences driver affect and user experience. Ergonomics, 1-19. https://doi.org/10.1080/00140139.2025.2592984",
    "Jose M Such, Agustín Espinosa, and Ana García-Fornes. 2014. A survey of privacy in multi-agent systems. The Knowledge Engineering Review 29, 3 (2014), 314-344.",
    "Mashrur Rashik, Mahmood Jasim, Kostiantyn Kucher, Ali Sarvghad, and Narges Mahyar. 2024. Beyond text and speech in conversational agents: Mapping the design space of avatars. In Proceedings of the 2024 ACM Designing Interactive Systems Conference. ACM, Copenhagen, Denmark, 1875-1894.",
]

REPLACEMENTS = [
    ("家庭语音设备的使用对象、使用场景和服务期待天然具有多样性。", "家庭语音设备的使用对象、使用场景和服务期待天然具有多样性[4][5]。"),
    ("单一语音助手很难同时满足不同年龄、不同任务和不同情绪语境下的期待；", "单一语音助手很难同时满足不同年龄、不同任务和不同情绪语境下的期待[1][3]；"),
    ("亚马逊、Google、三星等产品与生态中已经出现多个语音助手共存的探索，说明产业界也意识到单一助手难以覆盖全部服务生态。", "亚马逊、Google、三星等产品与生态中已经出现多个语音助手共存的探索，说明产业界也意识到单一助手难以覆盖全部服务生态[7]。"),
    ("多智能体或多代理系统在计算机、移动端、网页和教育系统中已有较多讨论，", "多智能体或多代理系统在计算机、移动端、网页和教育系统中已有较多讨论[6]，"),
    ("不同用户类型和不同场景会共同影响偏好。", "不同用户类型和不同场景会共同影响偏好[3][8]。"),
    ("屏幕和头像能够增强角色存在感，帮助用户快速判断当前服务者；", "屏幕和头像能够增强角色存在感，帮助用户快速判断当前服务者[10]；"),
    ("信息共享或旁听提示则关系到用户对隐私边界和系统可信度的理解。", "信息共享或旁听提示则关系到用户对隐私边界和系统可信度的理解[9]。"),
    ("系统首先根据用户类型、场景类型和前期问卷得到的偏好数据，对当前角色池进行初步排序；", "系统首先根据用户类型、场景类型和前期问卷得到的偏好数据，对当前角色池进行初步排序[2]；"),
]


def insert_paragraph_before(paragraph, text="", style=None):
    new_p = OxmlElement("w:p")
    paragraph._p.addprevious(new_p)
    new_para = paragraph.__class__(new_p, paragraph._parent)
    if style:
        new_para.style = style
    if text:
        new_para.add_run(text)
    return new_para


def main() -> None:
    doc = Document(str(DOCX))
    for old, new in REPLACEMENTS:
        done = False
        for para in doc.paragraphs:
            if old in para.text:
                text = para.text.replace(old, new)
                for i, run in enumerate(para.runs):
                    run.text = text if i == 0 else ""
                done = True
                break
        if not done:
            print("WARN missing:", old)

    # Remove existing references if rerun.
    ref_start = None
    achievement_idx = None
    for i, para in enumerate(doc.paragraphs):
        if para.text.strip() == "参考文献":
            ref_start = i
        if para.text.startswith("成果清单"):
            achievement_idx = i
            break
    if ref_start is not None and achievement_idx is not None and ref_start < achievement_idx:
        for para in doc.paragraphs[ref_start:achievement_idx]:
            para._element.getparent().remove(para._element)

    achievement = None
    for para in doc.paragraphs:
        if para.text.startswith("成果清单"):
            achievement = para
            break
    if achievement is None:
        raise RuntimeError("未找到成果清单")

    insert_paragraph_before(achievement, "", "Report Body")
    insert_paragraph_before(achievement, "参考文献", "Report Heading 1")
    for i, ref in enumerate(REFS, 1):
        insert_paragraph_before(achievement, f"[{i}] {ref}", "Report Body")

    doc.save(str(DOCX))
    print(DOCX)


if __name__ == "__main__":
    main()
