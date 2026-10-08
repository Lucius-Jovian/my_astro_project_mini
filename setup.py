# setup.py

from setuptools import setup, find_packages
import os

# 使用更安全的方式读取 README.md 文件作为项目详细描述
long_description = ""
if os.path.exists('README.md'):
    with open('README.md', 'r', encoding='utf-8') as f:
        long_description = f.read()

setup(
    name='quant-astro',
    version='0.2.2',  # 与 quant_astro/__init__.py 的 __version__ 保持一致（此前两边分别是 0.1.8 / 0.2.1，对不上）
    author='Lucius',
    author_email='kristenrobi85@gmail.com',
    description='一个用于量化占星研究的Python库。',
    long_description=long_description,
    long_description_content_type='text/markdown',
    url='https://github.com/LouiShadowMZ/quant-astro-lib.git',
    packages=find_packages(),

    # 包含了 data 和 ephe 目录下的所有文件
    package_data={
        'quant_astro': ['data/*', 'ephe/*'],
    },
    include_package_data=True,

    # 目前的计算底座（core.py）只用到了 pysweph，没有 import pandas/numpy。
    # pysweph>=2.10.3.3：这是 pysweph 这个 fork 的第一个发布版本；从这个版本起
    # calc()/calc_ut() 等函数的返回值多了一条 serr 字符串，houses 系列的 cusps
    # 数组从 2.10.3.4 起又改成了 13 项（index 0 留空）。core.py 的 _extract_12()
    # 和 _calc_body() 已经用长度判断兼容了这两种格式，所以不需要卡上限，但至少
    # 要卡住下限，明确声明"这份代码是针对哪个行为写的"。
    install_requires=[
        'pysweph>=2.10.3.3',
    ],

    classifiers=[
        'Programming Language :: Python :: 3',
        'License :: OSI Approved :: MIT License',
        'Operating System :: OS Independent',
        'Intended Audience :: Science/Research',
        'Topic :: Scientific/Engineering :: Astronomy',
    ],
    python_requires='>=3.8',
)
