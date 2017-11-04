#!/bin/bash

echo ""
echo "▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓"
echo "▓                                 ▓"
echo "▓   ▓▓▓   ▓  ▓ ▓▓▓▓▓ ▓▓▓▓▓ ▓▓▓    ▓"
echo "▓   ▓  ▓  ▓  ▓   ▓     ▓   ▓  ▓   ▓"
echo "▓   ▓  ▓  ▓▓▓▓   ▓     ▓   ▓▓▓    ▓"
echo "▓   ▓  ▓  ▓  ▓   ▓     ▓   ▓      ▓"
echo "▓   ▓▓▓   ▓  ▓   ▓     ▓   ▓      ▓"
echo "▓                                 ▓"
echo "▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓"
echo ""

# set cwd to gateway root
cd "${0%/*}"

# load the config
source ../config/config.sh

# ensure host has docker installed
if ! [ -x "$(command -v docker)" ]; then
  curl -fsSL get.docker.com | sh
  echo "-----------------------------------"
  echo "         DOCKER INSTALLED          "
  echo "-----------------------------------"
fi

# install certbot if required
if ! [ -x "$(command -v certbot)" ]; then
  apt-get update
  apt-get install software-properties-common  -qy
  add-apt-repository ppa:certbot/certbot -y
  apt-get update
  apt-get install certbot -qy
  echo "-----------------------------------"
  echo "         CERTBOT INSTALLED         "
  echo "-----------------------------------"
fi


read -p "Setup SSL certificate? [Y/N] " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
  # generate SSL certificate for domain
  echo "generating ssl certificate (if required)..."
  certbot \
    certonly \
    --standalone \
    --keep-until-expiring \
    --email $REGISTRY_EMAIL \
    -d $REGISTRY_DOMAIN

  # setup letsencrypt certificates auto-renewal
  CRON_TEXT="30 2 * * 1 certbot renew >> /var/log/letsencrypt-renew.log"
  CRON_EXISTS=$(cat /etc/crontab | grep "$CRON_TEXT")
  if [ -z $CRON_EXISTS ]; then
    echo "adding letsencrypt certificates auto-renewal cron..."
    echo $CRON_TEXT >> /etc/crontab
  fi

  # rename SSL certificates
  echo "compiling certifiate key/crt files..."
  SSL_DIR="/etc/letsencrypt/live/$REGISTRY_DOMAIN/"
  cp $SSL_DIR/privkey.pem $SSL_DIR/domain.key
  cat $SSL_DIR/cert.pem $SSL_DIR/chain.pem > $SSL_DIR/domain.crt
  chmod 777 $SSL_DIR/domain.crt $SSL_DIR/domain.key
  
  echo "-----------------------------------"
  echo "      SSL CERT SETUP COMPLETE      "
  echo "-----------------------------------"
fi

# create registry volume if required
QUEUE_VOLUME_EXISTS=$(docker volume ls --format "{{.Name}}" | grep ^dhttp-registry-data$)
if [ -z $QUEUE_VOLUME_EXISTS ]; then
  docker volume create \
    dhttp-registry-data
fi

# run docker registry
docker run \
  --name registry \
  --volume /etc/letsencrypt/live/$REGISTRY_DOMAIN:/certs \
  --volume dhttp-registry-data:/var/lib/registry \
  --env REGISTRY_HTTP_TLS_CERTIFICATE=/certs/domain.crt \
  --env REGISTRY_HTTP_TLS_KEY=/certs/domain.key \
  --publish 5000:5000 \
  --restart=always \
  --detach \
  registry:2

echo "-----------------------------------"
echo "       REGISTRY CONTAINER UP       "
echo "-----------------------------------"