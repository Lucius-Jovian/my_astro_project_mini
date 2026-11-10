"""共用区：档案系统（前后端）、天文基础、设置存取、页面外壳。

规则：common 里的任何代码都不 import systems/ 下的任何体系；
各体系只通过 common.system.AstroSystem 这一个接口挂进来。
"""
