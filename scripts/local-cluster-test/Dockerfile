FROM traceomics-r:single-host
USER root
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server && rm -rf /var/lib/apt/lists/* && mkdir -p /run/sshd /root/.ssh /cluster /scheduler
COPY scheduler /usr/local/bin/mock-scheduler
RUN chmod 755 /usr/local/bin/mock-scheduler && for cmd in sbatch sacct squeue scancel sinfo; do ln -s /usr/local/bin/mock-scheduler /usr/local/bin/$cmd; done
COPY sshd_config /etc/ssh/sshd_config
ENTRYPOINT []
CMD ["/bin/bash", "-ec", "cp /fixture/client.pub /root/.ssh/authorized_keys; chmod 700 /root/.ssh; chmod 600 /root/.ssh/authorized_keys; ssh-keygen -A; exec /usr/sbin/sshd -D -e"]
