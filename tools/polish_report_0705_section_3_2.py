from __future__ import annotations

from pathlib import Path

from docx import Document
from docx.oxml import OxmlElement
from docx.text.paragraph import Paragraph


DOCX = Path("/Users/renke/毕设/中期答辩/任科中期报告_0701_新框架版.docx")


def insert_after(paragraph: Paragraph, text: str, style: str = "Report Body") -> Paragraph:
    new_p = OxmlElement("w:p")
    paragraph._p.addnext(new_p)
    inserted = Paragraph(new_p, paragraph._parent)
    inserted.style = style
    inserted.add_run(text)
    return inserted


def replace_exact(doc: Document, old: str, new: str) -> int:
    count = 0
    for paragraph in doc.paragraphs:
        if paragraph.text == old:
            paragraph.text = new
            count += 1
    return count


def has_caption_after(doc: Document, image_para_idx: int) -> bool:
    if image_para_idx + 1 >= len(doc.paragraphs):
        return False
    return doc.paragraphs[image_para_idx + 1].style.name == "Report Caption"


def main() -> None:
    doc = Document(str(DOCX))

    replacements = {
        "基于用户研究，本研究对传统多智能体语音交互流程进行了重构。传统流程通常是“唤醒 Agent—选择 Agent—聊天—结束”。这种流程把选择责任放在用户身上，要求用户知道有哪些智能体、每个智能体擅长什么、应该如何唤醒。对于家庭场景而言，这种方式会带来较高的学习成本，尤其不适合老人、儿童和临时需求。":
        "基于前文的用户研究和竞品分析，本研究对多智能体语音交互流程进行了重新梳理。传统多智能体语音交互通常遵循“了解 Agent—记住唤醒词—唤醒指定 Agent—开始对话—结束对话”的路径。该路径的前提是用户已经知道系统中有哪些智能体，也知道每个智能体擅长什么、应该用什么唤醒词调用。对于家庭场景而言，这种方式把服务发现和角色选择的责任交给了用户，会带来较高的学习成本和记忆负担，尤其不适合老人、儿童和临时性的生活需求。",

        "本研究在保持基础依赖唤醒词的传统流程之外，新支持了 “需求识别—Agent 匹配—多 Agent 交互—长期学习”。在这一流程中，用户首先自然表达需求，系统识别用户当前意图、场景和必要的用户特征；随后系统根据强意图、弱意图和偏好数据匹配合适智能体；对话过程中，音箱屏幕和语音反馈持续表达当前智能体身份、状态和切换原因；对话结束后，系统可在用户授权下沉淀偏好、任务和长期记忆。":
        "因此，本研究并不是完全取消唤醒词，而是在保留“用户明确指定 Agent”这一基础方式的同时，新增“需求识别—Agent 匹配—多 Agent 交互—长期学习”的体验路径。在这一新流程中，用户可以直接说出自然需求，系统先识别当前意图、使用场景和必要的用户特征，再结合强意图、弱意图、偏好数据和长期记忆匹配合适的智能体。对话过程中，带屏音箱通过头像、状态动效和语音反馈持续表达当前智能体身份、系统状态与切换原因；对话结束后，系统在用户授权下沉淀偏好、任务和长期记忆，使后续匹配逐步从“系统帮用户选择一次”转向“系统逐渐理解这个家庭”。",

        "重构带来的新体验可以分成两个方面":
        "结合新补充的流程示意图，本研究将体验重构带来的变化概括为两个核心新体验。",

        "新体验 1 ：不依赖唤醒词，根据用户输入智能唤醒。体验重构的核心，不是让用户学习多个Agent，而是让系统主动理解不同用户、不同场景下的真实需求，并自动匹配最合适的智能体。":
        "第一，不再完全依赖唤醒词，而是根据用户输入进行智能唤醒。传统方式要求用户先选择智能体，再表达需求；新的方式则允许用户先自然表达需求，例如“我想听故事”“我今天有点不舒服”“帮我监督小朋友看电视”。系统根据语义、用户特征、场景和偏好数据判断需求类型，并自动唤起更合适的 Agent。也就是说，体验重构的重点不是让用户学习多个 Agent，而是让系统承担理解和匹配工作，降低用户主动选择的负担。",

        "新体验 2 ：不同用户同一输入，差异化匹配。通过多Agent的协同，系统能够在正确的时间、以正确的方式、由最合适的Agent，为不同用户提供更自然、高效、个性化的体验。":
        "第二，同一输入在不同用户和不同情境下可以得到差异化匹配。家庭语音设备面对的不是单一用户，儿童、成人和中老年用户即使说出相似的话，也可能期待不同的语气、角色和服务方式。例如同样是“陪我一下”，儿童可能更适合由亲切、鼓励型的陪伴智能体回应，成年人可能更需要情绪支持或任务协助，中老年用户则可能更需要清晰、稳重的解释和提醒。通过多 Agent 协同，系统能够在合适的时间、以合适的方式、由更合适的 Agent 承接需求，从而形成更自然的个性化体验。",

        "围绕这一重构，本研究同步设计了多智能体语音对话交互流程。":
        "在上述体验重构的基础上，本研究进一步设计了多智能体语音对话交互流程，用于说明新体验在真实对话中如何运行。",

        "语音交互流程用于明确系统在强意图、弱意图、会话保持中的状态变化，梳理用户如何在与多个智能体的交互过程中保持会话流畅，以及如何在智能体切换、会话保持、打断恢复和异步提醒中获得无缝的对话体验。":
        "该流程重点梳理系统在强意图、弱意图、会话保持和异步任务中的状态变化：当用户明确说出智能体名称或唤醒词时，系统直接切换到指定 Agent；当用户只表达模糊需求时，系统通过个性化匹配选择合适 Agent；当用户在短时间内继续追问时，系统优先保持当前会话，避免频繁误切换；当用户提出提醒、监督等跨时间任务时，系统则通过任务记忆在后续时刻主动唤起合适 Agent。通过这一流程，用户能够在多智能体切换、会话保持、打断恢复和异步提醒中获得更连贯的语音体验。"
    }

    for old, new in replacements.items():
        replace_exact(doc, old, new)

    # Add captions for the three newly inserted images in section 3.2 when missing.
    for i, paragraph in list(enumerate(doc.paragraphs)):
        if paragraph.text.strip() == "结合新补充的流程示意图，本研究将体验重构带来的变化概括为两个核心新体验。":
            prev = doc.paragraphs[i - 1]
            if "w:drawing" in prev._p.xml and prev.style.name != "Report Caption":
                insert_after(prev, "图 多智能体体验重构流程", "Report Caption")
            break

    # Re-read after insertion because paragraph indices may change.
    doc = Document(str(DOCX)) if False else doc
    for i, paragraph in list(enumerate(doc.paragraphs)):
        if paragraph.text.strip().startswith("第一，不再完全依赖唤醒词"):
            prev = doc.paragraphs[i - 1]
            if "w:drawing" in prev._p.xml:
                insert_after(prev, "图 新体验一：基于需求的智能唤醒", "Report Caption")
            break

    for i, paragraph in list(enumerate(doc.paragraphs)):
        if paragraph.text.strip().startswith("第二，同一输入在不同用户"):
            prev = doc.paragraphs[i - 1]
            if "w:drawing" in prev._p.xml:
                insert_after(prev, "图 新体验二：不同用户的差异化匹配", "Report Caption")
            break

    doc.save(str(DOCX))
    print(DOCX)


if __name__ == "__main__":
    main()
