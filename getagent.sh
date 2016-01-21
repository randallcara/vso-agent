#!/usr/bin/env bash

# TODO:
# node handler uses private copy
# doc separate scenarios

# run to install
# curl -sSL https://raw.githubusercontent.com/Microsoft/vso-agent/master/getagent.sh | bash

DEFAULT_NODE_VERSION="4.2.4"
#no version is latest
DEFAULT_AGENT_VERSION=""

function failed()
{
   local error=${1:-Undefined error}
   echo "Failed: $error" >&2
   exit 1
}

uid=`id -u`
platform=`uname`
if [ $uid -eq 0 ]; then
    failed "Install cannot be run as root.  Do not use sudo"
fi

agent_version=$1

if [ ! $agent_version ]; then
    agent_version=$DEFAULT_AGENT_VERSION
fi

node_version=$2

if [ ! $node_version ]; then
    node_version=$DEFAULT_NODE_VERSION
fi

function checkRC() {
    local rc=$?
    if [ $rc -ne 0 ]; then
        failed "${1} Failed with return code $rc"
    fi
}

function writeHeader() {
    echo 
    echo --------------------------------------
    echo "     ${1} "
    echo --------------------------------------
    echo
}

# password early in script
mkdir -p _install

# ------------------------------------------------------------
# Download Node
# ------------------------------------------------------------

writeHeader "Acquiring Node $node_version"
node_file='invalid'
if [[ "$platform" == "Darwin" ]]; then
    node_file="node-v${node_version}-darwin-x64"
elif [[ "$platform" == "Linux" ]]; then
    bitness=`uname -m`
    if [[ "$bitness" == "x86_64" ]]; then
        node_file="node-v${node_version}-linux-x64"
    else
        node_file="node-v${node_version}-linux-x86"
    fi
else
    failed 'Unsupported platform: $platform'
fi

zip_file=${node_file}.tar.gz
if [ -f ${zip_file} ]; then
    echo "Download exists"
else
    node_url="https://nodejs.org/dist/v${node_version}/${zip_file}"
    echo "Downloading Node ${node_version}"
    curl -skSLO $node_url &> _install/curl.log
    checkRC "Download (curl)"
fi

if [ -d ${node_file} ]; then
    echo "Already extracted"
else
    tar zxvf ./${zip_file} &> _install/targz.log
    checkRC "Unzip (tar)"
fi

if [ -d "runtime" ]; then
    echo "removing existing runtime"
    rm -rf "runtime"
fi

rm -rf runtime/node
mkdir -p runtime/node
cp -R ${node_file}/. runtime/node

# ensure we use private node and npm for rest of script
PATH=`pwd`/runtime/node/bin:$PATH
NPM_PATH=`which npm`
echo "using node : `which node`"
echo "using npm  : ${NPM_PATH}"

# ------------------------------------------------------------
# Install Agent
# ------------------------------------------------------------

writeHeader "Installing agent installer"
echo "Cleaning up existing agent"

if [ -f "package.json" ]; then
    rm package.json
    rm *.sh
fi

rm -rf agent
rm -rf node_modules
rm -rf _installer
mkdir -p _installer/node_modules
pushd _installer

echo Installing...
install_name=vsoagent-installer${agent_version}

# support installing locally built agent
# run script through curl and piping to sh will have dir of .
# if you run from locally built 
script_dir=$(dirname $0)
echo script location: ${script_dir}
if [ ${script_dir} != "." ] && [ ${script_dir} ]; then
    echo Dev Install.  Using location ${script_dir}
    install_name=${script_dir}
fi

echo installing ${install_name} ...
npm install ${install_name} &> ../_install/npminstall.log
checkRC "npm install"

writeHeader "Creating agent"
popd
cp -R _installer/node_modules/vsoagent-installer/agent .
cp -R _installer/node_modules/vsoagent-installer/*.sh .
cp _installer/node_modules/vsoagent-installer/package.json .
cp -R _installer/node_modules/vsoagent-installer/node_modules .

chmod 777 *.sh

rm -rf getagent.sh
rm -rf _installer

# logging info for troubleshooting
find . > _install/layout.log
ls -la > _install/ls.log
cat package.json | grep "\"version" > _install/version.log

writeHeader "Agent Installed! Next Steps:"
echo Run and Configure Interactively:
echo ./run.sh
echo
echo Configure Again:
echo ./configure.sh
echo
echo "See documentation for more options"
echo

