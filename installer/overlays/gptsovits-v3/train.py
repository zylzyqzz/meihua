import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
import site
import psutil
import torch
import yaml

version = "v2"
os.environ["version"] = version
torch.manual_seed(233333)

# 清理历史数据
cls_dirs = [
    "GPT_weights",
    "SoVITS_weights",
    "GPT_weights_v2",
    "SoVITS_weights_v2",
    "output",
    "logs",
    "TEMP",
]
for dir in cls_dirs:
    try:
        shutil.rmtree(dir)
    except Exception as e:
        pass

os.makedirs("TEMP", exist_ok=True)
os.makedirs("SoVITS_weights_v2", exist_ok=True)
os.makedirs("GPT_weights_v2", exist_ok=True)

# 添加path路径
now_dir = os.getcwd()
sys.path.insert(0, now_dir)

site_packages_roots = []
for path in site.getsitepackages():
    if "packages" in path:
        site_packages_roots.append(path)
if site_packages_roots == []:
    site_packages_roots = ["%s/runtime/Lib/site-packages" % now_dir]
for site_packages_root in site_packages_roots:
    if os.path.exists(site_packages_root):
        try:
            with open("%s/users.pth" % (site_packages_root), "w") as f:
                f.write(
                    "%s\n%s/tools\n%s/tools/asr\n%s/GPT_SoVITS\n%s/tools/uvr5"
                    % (now_dir, now_dir, now_dir, now_dir, now_dir)
                )
            break
        except PermissionError:
            pass


def runCommand(command):
    subprocess.check_call(command, shell=platform.system() != "Windows")


parser = argparse.ArgumentParser(description="Gpt Sovits Clone Audio")
parser.add_argument("--wav_path", required=True)
parser.add_argument("--exp_name", required=True)
parser.add_argument("--gpt_epoch", required=True, type=int)
parser.add_argument("--sovits_epoch", required=True, type=int)
parser.add_argument("--threshold", required=True, type=int)
args, unknown = parser.parse_known_args()

wav_path = args.wav_path
exp_name = args.exp_name
is_half = False
ngpu = torch.cuda.device_count()
gpu_infos = []
mem = []
if_gpu_ok = False

# 判断是否有能用来训练和加速推理的N卡
ok_gpu_keywords = {
    "10",
    "16",
    "20",
    "30",
    "40",
    "A2",
    "A3",
    "A4",
    "P4",
    "A50",
    "500",
    "A60",
    "70",
    "80",
    "90",
    "M4",
    "T4",
    "TITAN",
    "L4",
    "4060",
    "H",
}
set_gpu_numbers = set()
if torch.cuda.is_available() or ngpu != 0:
    for i in range(ngpu):
        gpu_name = torch.cuda.get_device_name(i)
        if any(value in gpu_name.upper() for value in ok_gpu_keywords):
            # A10#A100#V100#A40#P40#M40#K80#A4500
            if_gpu_ok = True  # 至少有一张能用的N卡
            gpu_infos.append("%s\t%s" % (i, gpu_name))
            set_gpu_numbers.add(i)
            mem.append(
                int(
                    torch.cuda.get_device_properties(i).total_memory
                    / 1024
                    / 1024
                    / 1024
                    + 0.4
                )
            )

if if_gpu_ok and len(gpu_infos) > 0:
    gpu_info = "\n".join(gpu_infos)
    default_batch_size = min(mem) // 2
else:
    gpu_info = "%s\t%s" % ("0", "CPU")
    gpu_infos.append("%s\t%s" % ("0", "CPU"))
    set_gpu_numbers.add(0)
    default_batch_size = int(psutil.virtual_memory().total / 1024 / 1024 / 1024 / 2)
gpus = "-".join([i[0] for i in gpu_infos])
gpu_numbers = f"{gpus}-{gpus}"
print("gpus", gpu_numbers, default_batch_size)

print("--------- 分割音频 ---------")
runCommand(
    f'python tools/slice_audio.py "{wav_path}" "output/slicer_opt" {args.threshold} 4000 300 10 500 0.9 0.25 0 1'
)
print("--------- 音频降噪 ---------")
runCommand(
    f'python tools/cmd-denoise.py -i "output/slicer_opt" -o "output/denoise_opt" -p float32'
)
print("--------- 批量ASR ---------")
runCommand(
    f'python tools/asr/funasr_asr.py -i "output/denoise_opt" -o "output/asr_opt" -s large -l zh -p float32'
)

print("--------- 语音转文字 ---------")
config = {
    "inp_text": "output/asr_opt/denoise_opt.list",
    "inp_wav_dir": "output/denoise_opt",
    "exp_name": exp_name,
    "opt_dir": f"logs/{exp_name}",
    "bert_pretrained_dir": "GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large",
}
gpu_names = gpu_numbers.split("-")
all_parts = len(gpu_names)
for i_part in range(all_parts):
    config.update(
        {
            "i_part": str(i_part),
            "all_parts": str(all_parts),
            "_CUDA_VISIBLE_DEVICES": gpu_names[i_part],
            "is_half": str(is_half),
        }
    )
    os.environ.update(config)
    runCommand(f"python GPT_SoVITS/prepare_datasets/1-get-text.py")

path_text = f"logs/{exp_name}/2-name2text.txt"
opt = []
for i_part in range(all_parts):  # txt_path="%s/2-name2text-%s.txt"%(opt_dir,i_part)
    txt_path = f"logs/{exp_name}/2-name2text-{i_part}.txt"
    with open(txt_path, "r", encoding="utf8") as f:
        opt += f.read().strip("\n").split("\n")
    os.remove(txt_path)
with open(path_text, "w", encoding="utf8") as f:
    f.write("\n".join(opt) + "\n")


print("--------- SSL解压 ---------")
config = {
    "inp_text": "output/asr_opt/denoise_opt.list",
    "inp_wav_dir": "output/denoise_opt",
    "exp_name": exp_name,
    "opt_dir": f"logs/{exp_name}",
    "cnhubert_base_dir": "GPT_SoVITS/pretrained_models/chinese-hubert-base",
    "is_half": str(is_half),
}
gpu_names = gpu_numbers.split("-")
all_parts = len(gpu_names)
for i_part in range(all_parts):
    config.update(
        {
            "i_part": str(i_part),
            "all_parts": str(all_parts),
            "_CUDA_VISIBLE_DEVICES": gpu_names[i_part],
        }
    )
    os.environ.update(config)
    runCommand(f"python GPT_SoVITS/prepare_datasets/2-get-hubert-wav32k.py")

print("--------- 语义令牌提取 ---------")
opt_dir = f"logs/{exp_name}"
config = {
    "inp_text": "output/asr_opt/denoise_opt.list",
    "exp_name": exp_name,
    "opt_dir": opt_dir,
    "pretrained_s2G": "GPT_SoVITS/pretrained_models/gsv-v2final-pretrained/s2G2333k.pth",
    "s2config_path": "GPT_SoVITS/configs/s2.json",
    "is_half": str(is_half),
}
gpu_names = gpu_numbers.split("-")
all_parts = len(gpu_names)
for i_part in range(all_parts):
    config.update(
        {
            "i_part": str(i_part),
            "all_parts": str(all_parts),
            "_CUDA_VISIBLE_DEVICES": gpu_names[i_part],
        }
    )
    os.environ.update(config)
    runCommand(f"python GPT_SoVITS/prepare_datasets/3-get-semantic.py")

opt = ["item_name\tsemantic_audio"]
path_semantic = f"logs/{exp_name}/6-name2semantic.tsv"
for i_part in range(all_parts):
    semantic_path = f"logs/{exp_name}/6-name2semantic-{i_part}.tsv"
    with open(semantic_path, "r", encoding="utf8") as f:
        opt += f.read().strip("\n").split("\n")
    os.remove(semantic_path)
with open(path_semantic, "w", encoding="utf8") as f:
    f.write("\n".join(opt) + "\n")

print("--------- 开始Sovits训练 ---------")
batch_size = default_batch_size
total_epoch = args.sovits_epoch
with open("GPT_SoVITS/configs/s2.json") as f:
    data = f.read()
    data = json.loads(data)
s2_dir = f"logs/{exp_name}"
os.makedirs(f"logs/{exp_name}/logs_s2", exist_ok=True)
if is_half == False:
    data["train"]["fp16_run"] = False
    batch_size = max(1, batch_size // 2)
data["train"]["batch_size"] = batch_size
data["train"]["epochs"] = total_epoch
data["train"]["text_low_lr_rate"] = 0.4
data["train"][
    "pretrained_s2G"
] = "GPT_SoVITS/pretrained_models/gsv-v2final-pretrained/s2G2333k.pth"
data["train"][
    "pretrained_s2D"
] = "GPT_SoVITS/pretrained_models/gsv-v2final-pretrained/s2D2333k.pth"
data["train"]["if_save_latest"] = True
data["train"]["if_save_every_weights"] = True
data["train"]["save_every_epoch"] = 4
data["train"]["gpu_numbers"] = "0"
data["model"]["version"] = version
data["data"]["exp_dir"] = data["s2_ckpt_dir"] = s2_dir
data["save_weight_dir"] = "SoVITS_weights_v2"
data["name"] = exp_name
data["version"] = "v2"

tmp_config_path = "TEMP/tmp_s2.json"
with open(tmp_config_path, "w") as f:
    f.write(json.dumps(data))
runCommand(f'python GPT_SoVITS/s2_train.py --config "TEMP/tmp_s2.json"')

print("--------- 开始GPT训练 ---------")
batch_size = default_batch_size
total_epoch = args.gpt_epoch
longer_yaml = "GPT_SoVITS/configs/s1longer.yaml"
if version == "v2":
    longer_yaml = "GPT_SoVITS/configs/s1longer-v2.yaml"
with open(longer_yaml) as f:
    data = f.read()
    data = yaml.load(data, Loader=yaml.FullLoader)
s1_dir = f"logs/{exp_name}"
os.makedirs("%s/logs_s1" % (s1_dir), exist_ok=True)
if is_half == False:
    data["train"]["precision"] = "32"
    batch_size = max(1, batch_size // 2)
data["train"]["batch_size"] = batch_size
data["train"]["epochs"] = total_epoch
data["pretrained_s1"] = (
    "GPT_SoVITS/pretrained_models/gsv-v2final-pretrained/s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt"
)
data["train"]["save_every_n_epoch"] = 5
data["train"]["if_save_every_weights"] = True
data["train"]["if_save_latest"] = True
data["train"]["if_dpo"] = False
data["train"]["half_weights_save_dir"] = "GPT_weights_v2"
data["train"]["exp_name"] = exp_name
data["train_semantic_path"] = "%s/6-name2semantic.tsv" % s1_dir
data["train_phoneme_path"] = "%s/2-name2text.txt" % s1_dir
data["output_dir"] = "%s/logs_s1" % s1_dir

# os.environ["_CUDA_VISIBLE_DEVICES"] = gpu_numbers.replace("-", ",")
os.environ["hz"] = "25hz"
tmp_config_path = "TEMP/tmp_s1.yaml"
with open(tmp_config_path, "w") as f:
    f.write(yaml.dump(data, default_flow_style=False))
runCommand(f'python GPT_SoVITS/s1_train.py --config_file "TEMP/tmp_s1.yaml"')
print("--------- 训练结束 ---------")
