# docker 部署

# 构建镜像文件
docker build -t github-pr-merge-scheduler . 

# 运行镜像（需要替换其中环境变量的值）
docker run -d --name github-pr-merge-scheduler --restart unless-stopped -e GITHUB_TOKEN="你的Token" -e GITHUB_OWNER="Boyedata361" -e GITHUB_REPO="361" github-pr-merge-scheduler