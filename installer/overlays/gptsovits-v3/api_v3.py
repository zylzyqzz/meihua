import os
import re
import sys
import threading
import traceback
import gc
import librosa
import numpy as np

# A portable package starts this API with stdout/stderr redirected to log
# files.  On Windows that otherwise defaults to the active ANSI code page,
# and an ordinary progress print containing a Chinese model label can crash a
# real synthesis request with UnicodeEncodeError.  Force a non-fatal UTF-8
# log stream before any model code is imported or prints diagnostics.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

now_dir = os.getcwd()
sys.path.append(now_dir)
sys.path.append("%s/GPT_SoVITS" % (now_dir))

import argparse
from functools import lru_cache
import soundfile as sf
from fastapi import FastAPI, Request
from AR.models.t2s_lightning_module import Text2SemanticLightningModule
from module.models import SynthesizerTrn
import torch
from tools.i18n.i18n import I18nAuto
import uvicorn
import LangSegment
from time import time as ttime
from tools.my_utils import load_audio
from module.mel_processing import spectrogram_torch
from text import cleaned_text_to_sequence
from text.cleaner import clean_text
from text import chinese
from transformers import AutoModelForMaskedLM, AutoTokenizer
from feature_extractor import cnhubert
import config as global_config

parser = argparse.ArgumentParser(description="GPT-SoVITS api")
parser.add_argument(
    "-a", "--host", type=str, default="0.0.0.0", help="default: 0.0.0.0"
)
parser.add_argument("-p", "--port", type=int, default="9881", help="default: 9880")
args = parser.parse_args()


app = FastAPI()
i18n = I18nAuto()
device = global_config.infer_device
is_half = global_config.is_half

dtype = torch.float16 if is_half == True else torch.float32
punctuation = set(["!", "?", "…", ",", ".", "-", " "])
splits = {
    "，",
    "。",
    "？",
    "！",
    ",",
    ".",
    "?",
    "!",
    "~",
    ":",
    "：",
    "—",
    "…",
}
dict_language = {
    i18n("中文"): "all_zh",  # 全部按中文识别
    i18n("英文"): "en",  # 全部按英文识别#######不变
    i18n("日文"): "all_ja",  # 全部按日文识别
    i18n("粤语"): "all_yue",  # 全部按中文识别
    i18n("韩文"): "all_ko",  # 全部按韩文识别
    i18n("中英混合"): "zh",  # 按中英混合识别####不变
    i18n("日英混合"): "ja",  # 按日英混合识别####不变
    i18n("粤英混合"): "yue",  # 按粤英混合识别####不变
    i18n("韩英混合"): "ko",  # 按韩英混合识别####不变
    i18n("多语种混合"): "auto",  # 多语种启动切分识别语种
    i18n("多语种混合(粤语)"): "auto_yue",  # 多语种启动切分识别语种
}


class DictToAttrRecursive(dict):
    def __init__(self, input_dict):
        super().__init__(input_dict)
        for key, value in input_dict.items():
            if isinstance(value, dict):
                value = DictToAttrRecursive(value)
            self[key] = value
            setattr(self, key, value)

    def __getattr__(self, item):
        try:
            return self[item]
        except KeyError:
            raise AttributeError(f"Attribute {item} not found")

    def __setattr__(self, key, value):
        if isinstance(value, dict):
            value = DictToAttrRecursive(value)
        super(DictToAttrRecursive, self).__setitem__(key, value)
        super().__setattr__(key, value)

    def __delattr__(self, item):
        try:
            del self[item]
        except KeyError:
            raise AttributeError(f"Attribute {item} not found")


cnhubert_base_path = global_config.cnhubert_path
bert_path = global_config.bert_path

cnhubert.cnhubert_base_path = cnhubert_base_path
# The original V3 entrypoint eagerly loaded both feature models at process
# startup.  That keeps several GB of VRAM occupied even while the service is
# idle, which prevents a single 8 GB card from safely switching to MuseTalk.
# Keep the service process light until a real synthesis request arrives.
ssl_model = None
tokenizer = None
bert_model = None
runtime_lock = threading.RLock()
runtime_started_at = ttime()
runtime_last_synthesis_at = None
runtime_last_release_at = None
runtime_synthesis_count = 0
runtime_busy = False


def runtime_uses_cuda():
    return "cuda" in str(device).lower() and torch.cuda.is_available()


def move_to_runtime_device(model):
    if is_half == True:
        return model.half().to(device)
    return model.to(device)


def ensure_feature_models():
    """Load BERT/CNHubert only for an active TTS request."""
    global ssl_model, tokenizer, bert_model
    with runtime_lock:
        if ssl_model is None:
            ssl_model = move_to_runtime_device(cnhubert.get_model())
            ssl_model.eval()
        if tokenizer is None:
            tokenizer = AutoTokenizer.from_pretrained(bert_path)
        if bert_model is None:
            bert_model = move_to_runtime_device(AutoModelForMaskedLM.from_pretrained(bert_path))
            bert_model.eval()
        return ssl_model, tokenizer, bert_model


def process_text(texts):
    _text = []
    if all(text in [None, " ", "\n", ""] for text in texts):
        raise ValueError(i18n("请输入有效文本"))
    for text in texts:
        if text in [None, " ", ""]:
            pass
        else:
            _text.append(text)
    return _text


def get_bert_inf(phones, word2ph, norm_text, language):
    language = language.replace("all_", "")
    if language == "zh":
        bert = get_bert_feature(norm_text, word2ph).to(device)  # .to(dtype)
    else:
        bert = torch.zeros(
            (1024, len(phones)),
            dtype=torch.float16 if is_half == True else torch.float32,
        ).to(device)

    return bert


def get_bert_feature(text, word2ph):
    _, active_tokenizer, active_bert_model = ensure_feature_models()
    with torch.no_grad():
        inputs = active_tokenizer(text, return_tensors="pt")
        for i in inputs:
            inputs[i] = inputs[i].to(device)
        res = active_bert_model(**inputs, output_hidden_states=True)
        res = torch.cat(res["hidden_states"][-3:-2], -1)[0].cpu()[1:-1]
    assert len(word2ph) == len(text)
    phone_level_feature = []
    for i in range(len(word2ph)):
        repeat_feature = res[i].repeat(word2ph[i], 1)
        phone_level_feature.append(repeat_feature)
    phone_level_feature = torch.cat(phone_level_feature, dim=0)
    return phone_level_feature.T


def get_spepc(hps, filename):
    audio = load_audio(filename, int(hps.data.sampling_rate))
    audio = torch.FloatTensor(audio)
    maxx = audio.abs().max()
    if maxx > 1:
        audio /= min(2, maxx)
    audio_norm = audio
    audio_norm = audio_norm.unsqueeze(0)
    spec = spectrogram_torch(
        audio_norm,
        hps.data.filter_length,
        hps.data.sampling_rate,
        hps.data.hop_length,
        hps.data.win_length,
        center=False,
    )
    return spec


def clean_text_inf(text, language, version):
    phones, word2ph, norm_text = clean_text(text, language, version)
    phones = cleaned_text_to_sequence(phones, version)
    return phones, word2ph, norm_text


def get_phones_and_bert(text, language, version, final=False):
    if language in {"en", "all_zh", "all_ja", "all_ko", "all_yue"}:
        language = language.replace("all_", "")
        if language == "en":
            LangSegment.setfilters(["en"])
            formattext = " ".join(tmp["text"] for tmp in LangSegment.getTexts(text))
        else:
            # 因无法区别中日韩文汉字,以用户输入为准
            formattext = text
        while "  " in formattext:
            formattext = formattext.replace("  ", " ")
        if language == "zh":
            if re.search(r"[A-Za-z]", formattext):
                formattext = re.sub(r"[a-z]", lambda x: x.group(0).upper(), formattext)
                formattext = chinese.mix_text_normalize(formattext)
                return get_phones_and_bert(formattext, "zh", version)
            else:
                phones, word2ph, norm_text = clean_text_inf(
                    formattext, language, version
                )
                bert = get_bert_feature(norm_text, word2ph).to(device)
        elif language == "yue" and re.search(r"[A-Za-z]", formattext):
            formattext = re.sub(r"[a-z]", lambda x: x.group(0).upper(), formattext)
            formattext = chinese.mix_text_normalize(formattext)
            return get_phones_and_bert(formattext, "yue", version)
        else:
            phones, word2ph, norm_text = clean_text_inf(formattext, language, version)
            bert = torch.zeros(
                (1024, len(phones)),
                dtype=torch.float16 if is_half == True else torch.float32,
            ).to(device)
    elif language in {"zh", "ja", "ko", "yue", "auto", "auto_yue"}:
        textlist = []
        langlist = []
        LangSegment.setfilters(["zh", "ja", "en", "ko"])
        if language == "auto":
            for tmp in LangSegment.getTexts(text):
                langlist.append(tmp["lang"])
                textlist.append(tmp["text"])
        elif language == "auto_yue":
            for tmp in LangSegment.getTexts(text):
                if tmp["lang"] == "zh":
                    tmp["lang"] = "yue"
                langlist.append(tmp["lang"])
                textlist.append(tmp["text"])
        else:
            for tmp in LangSegment.getTexts(text):
                if tmp["lang"] == "en":
                    langlist.append(tmp["lang"])
                else:
                    # 因无法区别中日韩文汉字,以用户输入为准
                    langlist.append(language)
                textlist.append(tmp["text"])
        phones_list = []
        bert_list = []
        norm_text_list = []
        for i in range(len(textlist)):
            lang = langlist[i]
            phones, word2ph, norm_text = clean_text_inf(textlist[i], lang, version)
            bert = get_bert_inf(phones, word2ph, norm_text, lang)
            phones_list.append(phones)
            norm_text_list.append(norm_text)
            bert_list.append(bert)
        bert = torch.cat(bert_list, dim=1)
        phones = sum(phones_list, [])
        norm_text = "".join(norm_text_list)

    if not final and len(phones) < 6:
        return get_phones_and_bert("." + text, language, version, final=True)

    return phones, bert.to(dtype), norm_text


def merge_short_text_in_array(texts, threshold):
    if (len(texts)) < 2:
        return texts
    result = []
    text = ""
    for ele in texts:
        text += ele
        if len(text) >= threshold:
            result.append(text)
            text = ""
    if len(text) > 0:
        if len(result) == 0:
            result.append(text)
        else:
            result[len(result) - 1] += text
    return result


def split(todo_text):
    todo_text = todo_text.replace("……", "。").replace("——", "，")
    if todo_text[-1] not in splits:
        todo_text += "。"
    i_split_head = i_split_tail = 0
    len_text = len(todo_text)
    todo_texts = []
    while 1:
        if i_split_head >= len_text:
            break  # 结尾一定有标点，所以直接跳出即可，最后一段在上次已加入
        if todo_text[i_split_head] in splits:
            i_split_head += 1
            todo_texts.append(todo_text[i_split_tail:i_split_head])
            i_split_tail = i_split_head
        else:
            i_split_head += 1
    return todo_texts


def cut1(inp):
    inp = inp.strip("\n")
    inps = split(inp)
    split_idx = list(range(0, len(inps), 4))
    split_idx[-1] = None
    if len(split_idx) > 1:
        opts = []
        for idx in range(len(split_idx) - 1):
            opts.append("".join(inps[split_idx[idx] : split_idx[idx + 1]]))
    else:
        opts = [inp]
    opts = [item for item in opts if not set(item).issubset(punctuation)]
    return "\n".join(opts)


def cut2(inp):
    inp = inp.strip("\n")
    inps = split(inp)
    if len(inps) < 2:
        return inp
    opts = []
    summ = 0
    tmp_str = ""
    for i in range(len(inps)):
        summ += len(inps[i])
        tmp_str += inps[i]
        if summ > 50:
            summ = 0
            opts.append(tmp_str)
            tmp_str = ""
    if tmp_str != "":
        opts.append(tmp_str)
    # print(opts)
    if len(opts) > 1 and len(opts[-1]) < 50:  ##如果最后一个太短了，和前一个合一起
        opts[-2] = opts[-2] + opts[-1]
        opts = opts[:-1]
    opts = [item for item in opts if not set(item).issubset(punctuation)]
    return "\n".join(opts)


def cut3(inp):
    inp = inp.strip("\n")
    opts = ["%s" % item for item in inp.strip("。").split("。")]
    opts = [item for item in opts if not set(item).issubset(punctuation)]
    return "\n".join(opts)


def cut4(inp):
    inp = inp.strip("\n")
    opts = ["%s" % item for item in inp.strip(".").split(".")]
    opts = [item for item in opts if not set(item).issubset(punctuation)]
    return "\n".join(opts)


# contributed by https://github.com/AI-Hobbyist/GPT-SoVITS/blob/main/GPT_SoVITS/inference_webui.py
def cut5(inp):
    inp = inp.strip("\n")
    punds = {",", ".", ";", "?", "!", "、", "，", "。", "？", "！", ";", "：", "…"}
    mergeitems = []
    items = []

    for i, char in enumerate(inp):
        if char in punds:
            if (
                char == "."
                and i > 0
                and i < len(inp) - 1
                and inp[i - 1].isdigit()
                and inp[i + 1].isdigit()
            ):
                items.append(char)
            else:
                items.append(char)
                mergeitems.append("".join(items))
                items = []
        else:
            items.append(char)

    if items:
        mergeitems.append("".join(items))

    opt = [item for item in mergeitems if not set(item).issubset(punds)]
    return "\n".join(opt)


def get_language(lang):
    key_name = [k for k, v in dict_language.items() if v == lang][0]
    return key_name


@lru_cache(maxsize=10)
def change_sovits_weights(sovits_path):
    dict_s2 = torch.load(sovits_path, map_location="cpu")
    hps = dict_s2["config"]
    hps = DictToAttrRecursive(hps)
    hps.model.semantic_frame_rate = "25hz"
    if dict_s2["weight"]["enc_p.text_embedding.weight"].shape[0] == 322:
        hps.model.version = "v1"
    else:
        hps.model.version = "v2"
    version = hps.model.version
    print("sovits版本:", sovits_path)
    vq_model = SynthesizerTrn(
        hps.data.filter_length // 2 + 1,
        hps.train.segment_size // hps.data.hop_length,
        n_speakers=hps.data.n_speakers,
        **hps.model,
    )
    if "pretrained" not in sovits_path:
        del vq_model.enc_q
    if is_half == True:
        vq_model = vq_model.half().to(device)
    else:
        vq_model = vq_model.to(device)
    vq_model.eval()
    print(vq_model.load_state_dict(dict_s2["weight"], strict=False))
    return vq_model, hps, version


@lru_cache(maxsize=10)
def change_gpt_weights(gpt_path):
    hz = 50
    dict_s1 = torch.load(gpt_path, map_location="cpu")
    config = dict_s1["config"]
    max_sec = config["data"]["max_sec"]
    t2s_model = Text2SemanticLightningModule(config, "****", is_train=False)
    t2s_model.load_state_dict(dict_s1["weight"])
    if is_half == True:
        t2s_model = t2s_model.half()
    t2s_model = t2s_model.to(device)
    t2s_model.eval()
    total = sum([param.nelement() for param in t2s_model.parameters()])
    print("gpt版本:", gpt_path)
    print("Number of parameter: %.2fM" % (total / 1e6))
    return hz, max_sec, t2s_model, config


vq_models = {}

@lru_cache(maxsize=30)
def get_prompt_wav(sovits_model_path, ref_wav_path, prompt_text, prompt_language):
    (vq_model, hps, version) = vq_models[sovits_model_path]
    active_ssl_model, _, _ = ensure_feature_models()
    prompt_text = prompt_text.strip("\n")
    if prompt_text[-1] not in splits:
        prompt_text += "。" if prompt_language != "en" else "."
      
    zero_wav = np.zeros(
        int(hps.data.sampling_rate * 0.3),
        dtype=np.float16 if is_half == True else np.float32,
    ) 
    with torch.no_grad():
        wav16k, sr = librosa.load(ref_wav_path, sr=16000)
        wav16k = torch.from_numpy(wav16k)
        zero_wav_torch = torch.from_numpy(zero_wav)
        if is_half == True:
            wav16k = wav16k.half().to(device)
            zero_wav_torch = zero_wav_torch.half().to(device)
        else:
            wav16k = wav16k.to(device)
            zero_wav_torch = zero_wav_torch.to(device)
        wav16k = torch.cat([wav16k, zero_wav_torch])
        ssl_content = active_ssl_model.model(wav16k.unsqueeze(0))[
            "last_hidden_state"
        ].transpose(
            1, 2
        )  # .float()
        codes = vq_model.extract_latent(ssl_content)
        prompt_semantic = codes[0, 0]
        prompt = prompt_semantic.unsqueeze(0).to(device) 
        
    phones1, bert1, norm_text1 = get_phones_and_bert(
        prompt_text, prompt_language, version
    )
    return prompt_text, zero_wav, prompt, phones1, bert1, norm_text1
    

def get_tts_wav(
    gpt_model_path,
    sovits_model_path,
    ref_wav_path,
    prompt_text,
    prompt_language,
    text,
    text_language,
    how_to_cut=i18n("不切"),
    top_k=20,
    top_p=0.6,
    temperature=0.6,
    speed=1,
):
    # 解决并发问题
    hz, max_sec, t2s_model, config = change_gpt_weights(gpt_model_path)
    vq_model, hps, version = change_sovits_weights(sovits_model_path)
    vq_models[sovits_model_path] = (vq_model, hps, version)

    prompt_language = dict_language[prompt_language]
    text_language = dict_language[text_language]

    prompt_text, zero_wav, prompt, phones1, bert1, norm_text1 = get_prompt_wav(sovits_model_path, ref_wav_path, prompt_text, prompt_language)

    text = text.strip("\n")
    if how_to_cut == i18n("凑四句一切"):
        text = cut1(text)
    elif how_to_cut == i18n("凑50字一切"):
        text = cut2(text)
    elif how_to_cut == i18n("按中文句号。切"):
        text = cut3(text)
    elif how_to_cut == i18n("按英文句号.切"):
        text = cut4(text)
    elif how_to_cut == i18n("按标点符号切"):
        text = cut5(text)
    while "\n\n" in text:
        text = text.replace("\n\n", "\n")
    # print(i18n("实际输入的目标文本(切句后):"), text)
    texts = text.split("\n")
    texts = process_text(texts)
    texts = merge_short_text_in_array(texts, 5)
    audio_opt = []

    for i_text, text in enumerate(texts):
        # 解决输入目标文本的空行导致报错的问题
        if len(text.strip()) == 0:
            continue
        if text[-1] not in splits:
            text += "。" if text_language != "en" else "."
        # print(i18n("实际输入的目标文本(每句):"), text)
        phones2, bert2, norm_text2 = get_phones_and_bert(text, text_language, version)
        # print(i18n("前端处理后的文本(每句):"), norm_text2)
        bert = torch.cat([bert1, bert2], 1)
        all_phoneme_ids = (
            torch.LongTensor(phones1 + phones2).to(device).unsqueeze(0)
        )

        bert = bert.to(device).unsqueeze(0)
        all_phoneme_len = torch.tensor([all_phoneme_ids.shape[-1]]).to(device)

        with torch.no_grad():
            pred_semantic, idx = t2s_model.model.infer_panel(
                all_phoneme_ids,
                all_phoneme_len,
                prompt,
                bert,
                top_k=top_k,
                top_p=top_p,
                temperature=temperature,
                early_stop_num=hz * max_sec,
            )
            pred_semantic = pred_semantic[:, -idx:].unsqueeze(0)

        refers = [get_spepc(hps, ref_wav_path).to(dtype).to(device)]
        audio = (
            vq_model.decode(
                pred_semantic,
                torch.LongTensor(phones2).to(device).unsqueeze(0),
                refers,
                speed=speed,
            )
            .detach()
            .cpu()
            .numpy()[0, 0]
        )
        max_audio = np.abs(audio).max()  # 简单防止16bit爆音
        if max_audio > 1:
            audio /= max_audio
        audio_opt.append(audio)
        audio_opt.append(zero_wav)
    yield hps.data.sampling_rate, (np.concatenate(audio_opt, 0) * 32768).astype(
        np.int16
    )


def empty_cache():
    try:
        gc.collect()  # 触发gc的垃圾回收。避免内存一直增长。
        if "cuda" in str(device):
            torch.cuda.empty_cache()
        elif str(device) == "mps":
            torch.mps.empty_cache()
    except:
        pass


def release_runtime_models():
    """Drop model/cache references so another local GPU service can run.

    This is intentionally explicit instead of relying on CUDA's allocator.  On
    an 8 GB card, MuseTalk must be able to start after a sentence has been
    synthesized without restarting the voice service.
    """
    global ssl_model, tokenizer, bert_model, runtime_last_release_at
    with runtime_lock:
        was_loaded = bool(ssl_model is not None or bert_model is not None or vq_models)
        ssl_model = None
        tokenizer = None
        bert_model = None
        vq_models.clear()
        change_sovits_weights.cache_clear()
        change_gpt_weights.cache_clear()
        get_prompt_wav.cache_clear()
        empty_cache()
        runtime_last_release_at = ttime()
        return {"released": was_loaded, "models_loaded": False}


def release_after_tts_enabled():
    return os.environ.get("MEIHUA_RELEASE_GPU_AFTER_TTS", "0").strip().lower() in {"1", "true", "yes", "on"}


def runtime_health():
    cuda_ready = runtime_uses_cuda()
    gpu_total_mb = None
    gpu_free_mb = None
    if cuda_ready:
        try:
            free_bytes, total_bytes = torch.cuda.mem_get_info()
            gpu_total_mb = int(total_bytes / 1024 / 1024)
            gpu_free_mb = int(free_bytes / 1024 / 1024)
        except Exception:
            pass
    return {
        "status": "ok",
        "ready": True,
        "api_version": "managed-v3",
        "accelerated": cuda_ready,
        "device": str(device),
        "runtime_state": "BUSY" if runtime_busy else "IDLE",
        "models_loaded": bool(ssl_model is not None or bert_model is not None or vq_models),
        "model_release_supported": True,
        "release_after_tts": release_after_tts_enabled(),
        "synthesis_count": runtime_synthesis_count,
        "last_synthesis_at": runtime_last_synthesis_at,
        "last_release_at": runtime_last_release_at,
        "gpu_total_mb": gpu_total_mb,
        "gpu_free_mb": gpu_free_mb,
        "gpu_profile": os.environ.get("MEIHUA_GPU_PROFILE", "AUTO"),
    }


@app.get("/health")
def health_endpoint():
    return runtime_health()


@app.post("/runtime/release")
def release_endpoint():
    return {"status": "ok", **release_runtime_models(), "released_at": runtime_last_release_at}


def synthesize_tts(json_post_raw):
    global runtime_busy, runtime_last_synthesis_at, runtime_synthesis_count

    gpt_model_path = json_post_raw.get("gpt_model_path")
    sovits_model_path = json_post_raw.get("sovits_model_path")
    ref_wav_path = json_post_raw.get("refer_wav_path")
    ref_text = json_post_raw.get("ref_text")
    ref_language = json_post_raw.get("ref_language", "zh")
    target_text = json_post_raw.get("text")
    target_language = json_post_raw.get("text_language", "zh")
    output_path = json_post_raw.get("output_path")
    how_to_cut = json_post_raw.get("how_to_cut", "不切")
    speed = json_post_raw.get("speed", 1)
    if not ref_wav_path or not os.path.exists(ref_wav_path):
        raise Exception(f"not found {ref_wav_path}")
    if not target_text or not str(target_text).strip():
        raise Exception("target text is required")
    if not output_path:
        raise Exception("output_path is required")
    if not gpt_model_path or not os.path.exists(gpt_model_path):
        gpt_model_path = "GPT_SoVITS/pretrained_models/gsv-v2final-pretrained/s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt"
    if not sovits_model_path or not os.path.exists(sovits_model_path):
        sovits_model_path = (
            "GPT_SoVITS/pretrained_models/gsv-v2final-pretrained/s2G2333k.pth"
        )

    with runtime_lock:
        runtime_busy = True
        try:
            synthesis_result = get_tts_wav(
                gpt_model_path=gpt_model_path,
                sovits_model_path=sovits_model_path,
                ref_wav_path=ref_wav_path,
                prompt_text=ref_text,
                prompt_language=get_language(ref_language),
                text=target_text,
                text_language=get_language(target_language),
                top_k=15,
                top_p=1,
                temperature=1,
                speed=float(speed),
                how_to_cut=how_to_cut
            )

            result_list = list(synthesis_result)
            if result_list:
                last_sampling_rate, last_audio_data = result_list[-1]
                output_directory = os.path.dirname(os.path.abspath(output_path))
                if output_directory:
                    os.makedirs(output_directory, exist_ok=True)
                sf.write(output_path, last_audio_data, last_sampling_rate)
                runtime_synthesis_count += 1
                runtime_last_synthesis_at = ttime()
                print(f"Audio saved to {output_path}")
                return {"status": "ok", "output_path": output_path}
            raise Exception("Audio error")
        finally:
            runtime_busy = False
            if release_after_tts_enabled():
                release_runtime_models()


@app.post("/")
async def tts_endpoint(request: Request):
    # The actual inference is synchronous/heavy.  Run it on FastAPI's worker
    # pool so /health stays observable while a long sentence is being rendered.
    from starlette.concurrency import run_in_threadpool
    return await run_in_threadpool(synthesize_tts, await request.json())


def start():
    uvicorn.run(app, host=args.host, port=args.port, workers=1)


if __name__ == "__main__":
    start()
